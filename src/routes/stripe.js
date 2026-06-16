// backend/src/routes/stripe.js
// Stripe billing integration — usage-based invoicing for tenants
const express = require('express')
const router  = express.Router()
const Stripe  = require('stripe')
const { PrismaClient } = require('@prisma/client')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')

const prisma = new PrismaClient()
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
        email: req.user.email,
        metadata: { tenantId: tenant.id }
      })
      customerId = customer.id
      await prisma.tenant.update({
        where: { id: tenant.id },
        data:  { stripeCustomerId: customerId }
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

    // Create invoice item then finalise
    await stripe.invoiceItems.create({
      customer:    tenant.stripeCustomerId,
      amount:      totalAmount,
      currency:    'usd',
      description: `VoCallM usage — ${agg._sum.minutes?.toFixed(1)} min @ $${tenant.ratePerMinute}/min (${month})`
    })

    const invoice = await stripe.invoices.create({
      customer:         tenant.stripeCustomerId,
      auto_advance:     true,
      collection_method: 'charge_automatically',
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
        email: req.user.email,
        metadata: { tenantId: tenant.id }
      })
      customerId = customer.id
      await prisma.tenant.update({ where: { id: tenant.id }, data: { stripeCustomerId: customerId } })
    }

    // Get or create Stripe Price (cached on plan.stripePriceId to avoid duplicates)
    let priceId = plan.stripePriceId
    if (!priceId) {
      const product = await stripe.products.create({
        name: `VoCallM ${plan.name} Plan`,
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
    const origin = req.headers.origin || process.env.FRONTEND_ADMIN_URL || 'http://localhost:8080'

    // If tenant already has a subscription, use subscription update instead
    if (tenant.stripeSubscriptionId) {
      const sub = await stripe.subscriptions.retrieve(tenant.stripeSubscriptionId)
      await stripe.subscriptions.update(tenant.stripeSubscriptionId, {
        items: [{ id: sub.items.data[0].id, price: priceId }],
        metadata: { tenantId: tenant.id, planId: plan.id },
        proration_behavior: 'always_invoice',
      })
      // Assign plan immediately on upgrade
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { planId: plan.id, ratePerMinute: plan.price }
      })
      return res.json({ upgraded: true })
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata:   { tenantId: tenant.id, planId: plan.id },
      subscription_data: {
        metadata: { tenantId: tenant.id, planId: plan.id }
      },
      success_url: `${origin}/portal/billing?checkout=success`,
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

        const plan = await prisma.plan.findUnique({ where: { id: planId } })
        if (!plan) break

        await prisma.tenant.update({
          where: { id: tenantId },
          data: {
            planId,
            ratePerMinute:        plan.price,
            stripeCustomerId:     session.customer,
            stripeSubscriptionId: session.subscription,
          }
        })
        console.log(`[stripe] Plan "${plan.name}" activated for tenant ${tenantId}`)
        break
      }

      // ── Subscription invoice paid — log it ──────────────────────────────────
      case 'invoice.paid': {
        const inv = event.data.object
        // Only subscription invoices (not our manual usage ones)
        if (!inv.subscription) break
        const tenant = await prisma.tenant.findFirst({
          where: { stripeSubscriptionId: inv.subscription }
        })
        if (tenant) {
          console.log(`[stripe] Subscription invoice paid — tenant ${tenant.id}, $${inv.amount_paid / 100}`)
        }
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

      // ── Subscription cancelled ───────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const tenant = await prisma.tenant.findFirst({
          where: { stripeSubscriptionId: sub.id }
        })
        if (tenant) {
          await prisma.tenant.update({
            where: { id: tenant.id },
            data: { planId: null, stripeSubscriptionId: null }
          })
          console.log(`[stripe] Subscription cancelled for tenant ${tenant.id}`)
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
