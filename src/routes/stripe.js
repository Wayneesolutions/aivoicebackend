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

// ── POST /api/stripe/webhook ──────────────────────────────────────────────────
// Stripe sends payment events here (invoice.paid, invoice.payment_failed, etc.)
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
      case 'invoice.paid': {
        const inv = event.data.object
        const customer = await stripe.customers.retrieve(inv.customer)
        const tenantId = customer.metadata?.tenantId
        if (tenantId) {
          console.log(`[stripe] Invoice paid — tenant ${tenantId}, amount $${inv.amount_paid / 100}`)
          // Could update a "balance" or send a receipt email here
        }
        break
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object
        const customer = await stripe.customers.retrieve(inv.customer)
        console.error(`[stripe] Payment failed — customer ${inv.customer}, tenant ${customer.metadata?.tenantId}`)
        // Could pause the tenant's campaigns here
        break
      }
    }
  } catch (err) {
    console.error('[stripe] Webhook handler error:', err.message)
  }

  res.json({ received: true })
})

module.exports = router
