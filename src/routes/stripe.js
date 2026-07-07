// backend/src/routes/stripe.js
// Stripe billing integration — usage-based invoicing for tenants
const express = require('express')
const router  = express.Router()
const Stripe  = require('stripe')
const prisma = require('../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')

const stripe = Stripe(process.env.STRIPE_SECRET_KEY)

// ── POST /api/stripe/setup-intent ────────────────────────────────────────────
// Returns a SetupIntent so the tenant can save a payment method (card)
router.post('/setup-intent', requireTenantOwner, async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant.id } })

    // Create Stripe customer if not already done
    let customerId = tenant.stripeCustomerId
    if (!customerId) {
      const customer = await stripe.customers.create({
        name:  tenant.name,
        email: tenant.ownerEmail || req.user.email,
        description: `Quor client — ${tenant.ownerName || tenant.name}`,
        metadata: { tenantId: tenant.id, ownerName: tenant.ownerName || '', ownerEmail: tenant.ownerEmail || '' }
      })
      customerId = customer.id
      await prisma.tenant.update({
        where: { id: tenant.id },
        data:  { stripeCustomerId: customerId }
      })
    } else {
      // Keep customer details up to date
      await stripe.customers.update(customerId, {
        name:  tenant.name,
        email: tenant.ownerEmail || req.user.email,
        metadata: { tenantId: tenant.id, ownerName: tenant.ownerName || '', ownerEmail: tenant.ownerEmail || '' }
      })
    }

    const intent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    })

    res.json({ clientSecret: intent.client_secret, customerId })
  } catch (err) { next(err) }
})

// ── GET /api/stripe/payment-method ───────────────────────────────────────────
// Returns the tenant's saved card (last 4, brand, expiry)
router.get('/payment-method', requireTenantUser, async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant.id } })
    if (!tenant.stripeCustomerId) return res.json({ card: null })

    const methods = await stripe.paymentMethods.list({
      customer: tenant.stripeCustomerId,
      type: 'card',
      limit: 1
    })

    const pm = methods.data[0]
    if (!pm) return res.json({ card: null })

    res.json({
      card: {
        id:     pm.id,
        brand:  pm.card.brand,
        last4:  pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear:  pm.card.exp_year,
      }
    })
  } catch (err) { next(err) }
})

// ── POST /api/stripe/set-default-payment-method ──────────────────────────────
// Sets the newly-confirmed card as the customer default and detaches old ones.
// Called by the frontend immediately after stripe.confirmCardSetup() succeeds.
router.post('/set-default-payment-method', requireTenantOwner, async (req, res, next) => {
  try {
    const { paymentMethodId } = req.body
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' })

    const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant.id } })
    if (!tenant.stripeCustomerId) return res.status(400).json({ error: 'No Stripe customer found' })

    // Set as the default for all future invoices
    await stripe.customers.update(tenant.stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    })

    // Detach every other card so there's no accumulation
    const methods = await stripe.paymentMethods.list({
      customer: tenant.stripeCustomerId,
      type: 'card',
    })
    await Promise.all(
      methods.data
        .filter(pm => pm.id !== paymentMethodId)
        .map(pm => stripe.paymentMethods.detach(pm.id))
    )

    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── POST /api/stripe/invoice ─────────────────────────────────────────────────
// Creates and finalises a Stripe invoice for unbilled usage in a given month.
// Called manually by admin or by a monthly cron.
router.post('/invoice', requireTenantOwner, async (req, res, next) => {
  try {
    const { month } = req.body   // e.g. "2026-06"
    const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant.id } })

    if (!tenant.stripeCustomerId) {
      return res.status(400).json({ error: 'No payment method on file. Add a card first.' })
    }

    // Date range for the month
    const [year, mo] = (month || new Date().toISOString().slice(0, 7)).split('-').map(Number)
    const from = new Date(year, mo - 1, 1)
    const to   = new Date(year, mo, 1)

    // Sum all billed usage for this tenant+month
    const agg = await prisma.usageLog.aggregate({
      where: { tenantId: req.tenant.id, createdAt: { gte: from, lt: to } },
      _sum: { minutes: true, amount: true }
    })

    const totalAmount = Math.round((agg._sum.amount || 0) * 100)   // Stripe wants cents
    if (totalAmount === 0) {
      return res.json({ message: 'No usage to invoice for this period.' })
    }

    const [year2, mo2] = (month || new Date().toISOString().slice(0, 7)).split('-').map(Number)
    const periodLabel = new Date(year2, mo2 - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const planLabel   = tenant.plan ? tenant.plan.name : 'Pay-as-you-go'
    const minutes     = agg._sum.minutes?.toFixed(1) || '0.0'

    // Ensure Stripe customer has latest company details
    await stripe.customers.update(tenant.stripeCustomerId, {
      name:  tenant.name,
      email: tenant.ownerEmail,
      description: `Quor client — ${tenant.ownerName || tenant.name}`,
      metadata: { tenantId: tenant.id }
    })

    // Create invoice item with billing period
    await stripe.invoiceItems.create({
      customer:    tenant.stripeCustomerId,
      amount:      totalAmount,
      currency:    'usd',
      description: `AI Calling — ${minutes} minutes @ $${parseFloat(tenant.ratePerMinute).toFixed(2)}/min`,
      period: {
        start: Math.floor(from.getTime() / 1000),
        end:   Math.floor(to.getTime()   / 1000),
      }
    })

    const invoice = await stripe.invoices.create({
      customer:          tenant.stripeCustomerId,
      auto_advance:      true,
      collection_method: 'charge_automatically',
      description:       `Quor AI Calling — ${periodLabel}`,
      custom_fields: [
        { name: 'Plan',           value: planLabel },
        { name: 'Billing period', value: periodLabel },
        { name: 'Minutes used',   value: `${minutes} min` },
        { name: 'Rate',           value: `$${parseFloat(tenant.ratePerMinute).toFixed(2)}/min` },
      ],
      footer: 'Quor by Wayne E Solutions · support@vocallm.com · vocallm.com\nThank you for your business.',
      metadata: { tenantId: tenant.id, month: month || new Date().toISOString().slice(0, 7) }
    })

    const finalised = await stripe.invoices.finalizeInvoice(invoice.id)

    res.json({
      invoiceId:  finalised.id,
      amountDue:  finalised.amount_due / 100,
      status:     finalised.status,
      hostedUrl:  finalised.hosted_invoice_url,
    })
  } catch (err) { next(err) }
})

// ── GET /api/stripe/invoices ──────────────────────────────────────────────────
// Lists past Stripe invoices for the tenant
router.get('/invoices', requireTenantUser, async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant.id } })
    if (!tenant.stripeCustomerId) return res.json([])

    const invoices = await stripe.invoices.list({
      customer: tenant.stripeCustomerId,
      limit: 12,
    })

    res.json(invoices.data.map(inv => ({
      id:         inv.id,
      period:     new Date(inv.period_start * 1000).toISOString().slice(0, 7),
      amount:     inv.amount_due / 100,
      status:     inv.status,
      paidAt:     inv.status_transitions?.paid_at
        ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
        : null,
      hostedUrl:  inv.hosted_invoice_url,
      pdfUrl:     inv.invoice_pdf,
    })))
  } catch (err) { next(err) }
})

// ── POST /api/stripe/checkout ─────────────────────────────────────────────────
// Creates a Stripe Checkout Session for plan subscription purchase.
// Client is redirected to Stripe's hosted checkout page.
router.post('/checkout', requireTenantOwner, async (req, res, next) => {
  try {
    const { planId } = req.body
    if (!planId) return res.status(400).json({ error: 'planId required' })

    const [plan, tenant] = await Promise.all([
      prisma.plan.findUnique({ where: { id: planId } }),
      prisma.tenant.findUnique({ where: { id: req.tenant.id } })
    ])

    if (!plan || !plan.isActive) return res.status(404).json({ error: 'Plan not found' })
    if (plan.price === 0) return res.status(400).json({ error: 'Free plans do not require checkout' })
    if (plan.minutesIncluded === 0) {
      return res.status(400).json({ error: 'Unlimited plans require a custom quote — contact us.' })
    }

    // Monthly subscription amount = per-min rate × included minutes (in cents)
    const monthlyAmountCents = Math.round(plan.price * plan.minutesIncluded * 100)

    // Create or get Stripe customer
    let customerId = tenant.stripeCustomerId
    if (!customerId) {
      const customer = await stripe.customers.create({
        name:  tenant.name,
        email: tenant.ownerEmail || req.user.email,
        description: `Quor client — ${tenant.ownerName || tenant.name}`,
        metadata: { tenantId: tenant.id, ownerName: tenant.ownerName || '', ownerEmail: tenant.ownerEmail || '' }
      })
      customerId = customer.id
      await prisma.tenant.update({ where: { id: tenant.id }, data: { stripeCustomerId: customerId } })
    } else {
      await stripe.customers.update(customerId, {
        name:  tenant.name,
        email: tenant.ownerEmail || req.user.email,
        metadata: { tenantId: tenant.id, ownerName: tenant.ownerName || '', ownerEmail: tenant.ownerEmail || '' }
      })
    }

    // Get or create Stripe Price (cached on plan.stripePriceId to avoid duplicates)
    let priceId = plan.stripePriceId
    if (!priceId) {
      const product = await stripe.products.create({
        name: `Quor ${plan.name} Plan`,
        metadata: { planId: plan.id }
      })
      const price = await stripe.prices.create({
        product:   product.id,
        unit_amount: monthlyAmountCents,
        currency:  'usd',
        recurring: { interval: 'month' },
      })
      priceId = price.id
      await prisma.plan.update({ where: { id: plan.id }, data: { stripePriceId: priceId } })
    }

    // Redirect back to billing page after checkout
    const origin = process.env.FRONTEND_CLIENT_URL || 'http://localhost:8080'

    // Block mid-cycle plan changes — lock as long as an active subscription exists
    if (tenant.stripeSubscriptionId) {
      const expiresAt = tenant.planExpiresAt ? new Date(tenant.planExpiresAt) : null
      const isExpired = expiresAt ? expiresAt < new Date() : false

      if (!isExpired) {
        // Allow re-subscribing to the SAME plan (idempotent)
        if (tenant.planId === plan.id) {
          return res.json({ alreadyActive: true })
        }
        return res.status(400).json({
          error: 'Plan change not allowed mid-cycle',
          planExpiresAt: tenant.planExpiresAt,
          code: 'MID_CYCLE_CHANGE'
        })
      }

      // Subscription period has ended — cancel old subscription and start fresh
      await stripe.subscriptions.cancel(tenant.stripeSubscriptionId)
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { stripeSubscriptionId: null, planId: null, planExpiresAt: null }
      })
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata:   { tenantId: tenant.id, planId: plan.id },
      subscription_data: {
        metadata:    { tenantId: tenant.id, planId: plan.id },
        description: `Quor ${plan.name} Plan — ${tenant.name}`,
      },
      success_url: `${origin}/checkout/success`,
      cancel_url:  `${origin}/portal/billing?checkout=cancelled`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
    })

    res.json({ url: session.url })
  } catch (err) { next(err) }
})

// ── POST /api/stripe/webhook ──────────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('[stripe] Webhook signature failed:', err.message)
    return res.status(400).send('Webhook Error')
  }

  try {
    switch (event.type) {

      // ── Plan purchase completed ──────────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object
        if (session.mode !== 'subscription') break

        const { tenantId, planId } = session.metadata || {}
        if (!tenantId || !planId) break

        const [plan, subscription] = await Promise.all([
          prisma.plan.findUnique({ where: { id: planId } }),
          stripe.subscriptions.retrieve(session.subscription)
        ])
        if (!plan) break

        // current_period_end can be null on some Stripe test subscriptions — fall back to 30 days
        const periodEnd = subscription.current_period_end
        const planExpiresAt = periodEnd
          ? new Date(periodEnd * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

        await prisma.tenant.update({
          where: { id: tenantId },
          data: {
            planId,
            ratePerMinute:        plan.price,
            stripeCustomerId:     session.customer,
            stripeSubscriptionId: session.subscription,
            planExpiresAt,
          }
        })
        console.log(`[stripe] Plan "${plan.name}" activated for tenant ${tenantId} — expires ${planExpiresAt.toISOString()}`)
        break
      }

      // ── Subscription invoice created — add branding before finalization ───────
      case 'invoice.created': {
        const inv = event.data.object
        // Only customize subscription invoices (not manual one-off invoices)
        if (!inv.subscription || inv.status !== 'draft') break

        const tenant = await prisma.tenant.findFirst({
          where: { stripeSubscriptionId: inv.subscription },
          include: { plan: true }
        })
        if (!tenant) break

        try {
          await stripe.invoices.update(inv.id, {
            description: `Quor ${tenant.plan?.name || 'Plan'} — ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
            custom_fields: [
              { name: 'Plan',   value: tenant.plan?.name || 'Subscription' },
              { name: 'Client', value: tenant.name },
            ],
            footer: 'Quor by Wayne E Solutions · support@vocallm.com · vocallm.com\nThank you for your business.',
          })
        } catch (e) {
          console.error('[stripe] Could not update draft invoice:', e.message)
        }
        break
      }

      // ── Subscription invoice paid — renew plan expiry ───────────────────────
      case 'invoice.paid': {
        const inv = event.data.object
        if (!inv.subscription) break
        const tenant = await prisma.tenant.findFirst({
          where: { stripeSubscriptionId: inv.subscription }
        })
        if (!tenant) break

        // Fetch the subscription to get the new period end
        const subscription = await stripe.subscriptions.retrieve(inv.subscription)
        const renewEnd = subscription.current_period_end
        const planExpiresAt = renewEnd
          ? new Date(renewEnd * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

        await prisma.tenant.update({
          where: { id: tenant.id },
          data: { planExpiresAt }
        })
        console.log(`[stripe] Subscription renewed — tenant ${tenant.id}, new expiry ${planExpiresAt.toISOString()}, $${inv.amount_paid / 100}`)
        break
      }

      // ── Payment failed — pause campaigns ────────────────────────────────────
      case 'invoice.payment_failed': {
        const inv = event.data.object
        if (!inv.subscription) break
        const tenant = await prisma.tenant.findFirst({
          where: { stripeSubscriptionId: inv.subscription }
        })
        if (tenant) {
          await prisma.campaign.updateMany({
            where: { tenantId: tenant.id, status: 'ACTIVE' },
            data:  { status: 'PAUSED' }
          })
          console.warn(`[stripe] Payment failed — paused campaigns for tenant ${tenant.id}`)
        }
        break
      }

      // ── Subscription cancelled — remove plan immediately ─────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const tenant = await prisma.tenant.findFirst({
          where: { stripeSubscriptionId: sub.id }
        })
        if (tenant) {
          await prisma.tenant.update({
            where: { id: tenant.id },
            data: { planId: null, stripeSubscriptionId: null, planExpiresAt: null }
          })
          await prisma.campaign.updateMany({
            where: { tenantId: tenant.id, status: 'ACTIVE' },
            data:  { status: 'PAUSED' }
          })
          console.log(`[stripe] Subscription cancelled for tenant ${tenant.id} — plan removed`)
        }
        break
      }
    }
  } catch (err) {
    console.error('[stripe] Webhook handler error:', err.message)
  }

  res.json({ received: true })
})

module.exports = router
