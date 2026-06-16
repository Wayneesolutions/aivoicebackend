// backend/src/routes/admin.js
// All routes here require super admin auth (Wayne Solutions team only)
const router = require('express').Router()
const bcrypt = require('bcryptjs')
const path   = require('path')
const multer = require('multer')
const { PrismaClient } = require('@prisma/client')
const { requireAdmin } = require('../middleware/auth')
const vapiService  = require('../services/vapi')
const storageService = require('../services/storage')
const prisma = new PrismaClient()

// Multer memory storage — file sent to S3 or disk via storageService
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'))
    cb(null, true)
  }
})

router.use(requireAdmin)

// ── DASHBOARD STATS ────────────────────────────────────

// GET /api/admin/stats
router.get('/stats', async (req, res, next) => {
  try {
    const [tenantCount, callsToday, minutesToday, meetingsToday] = await Promise.all([
      prisma.tenant.count({ where: { status: 'ACTIVE' } }),
      prisma.call.count({ where: { createdAt: { gte: startOfDay() } } }),
      prisma.call.aggregate({
        where: { createdAt: { gte: startOfDay() } },
        _sum: { billedMinutes: true }
      }),
      prisma.call.count({
        where: { outcome: 'BOOKED', createdAt: { gte: startOfDay() } }
      })
    ])

    const revenueToday = await prisma.usageLog.aggregate({
      where: { createdAt: { gte: startOfDay() } },
      _sum: { amount: true }
    })

    res.json({
      activeClients: tenantCount,
      callsToday,
      minutesToday: minutesToday._sum.billedMinutes || 0,
      meetingsToday,
      revenueToday: revenueToday._sum.amount || 0
    })
  } catch (err) { next(err) }
})

// ── GLOBAL SEARCH ──────────────────────────────────────

// GET /api/admin/search?q=...
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim()
    if (!q || q.length < 2) return res.json({ clients: [], scripts: [], leads: [] })

    const where = { contains: q, mode: 'insensitive' }

    const [clients, scripts, leads] = await Promise.all([
      prisma.tenant.findMany({
        where: {
          OR: [
            { name: where },
            { ownerEmail: where },
            { ownerName: where },
            { slug: where },
          ]
        },
        select: { id: true, name: true, ownerEmail: true, status: true },
        take: 5,
        orderBy: { name: 'asc' },
      }),

      prisma.script.findMany({
        where: {
          OR: [
            { title: where },
            { tenant: { name: where } },
          ]
        },
        select: {
          id: true, title: true, status: true,
          tenant: { select: { id: true, name: true } },
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),

      prisma.lead.findMany({
        where: {
          OR: [
            { name: where },
            { phone: where },
            { email: where },
            { company: where },
          ]
        },
        select: {
          id: true, name: true, phone: true, status: true,
          campaign: { select: { tenant: { select: { id: true, name: true } } } },
        },
        take: 5,
        orderBy: { name: 'asc' },
      }),
    ])

    res.json({ clients, scripts, leads })
  } catch (err) { next(err) }
})

// ── TENANT MANAGEMENT ──────────────────────────────────

// GET /api/admin/tenants
router.get('/tenants', async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      include: {
        phoneNumbers: true,
        plan: { select: { id: true, name: true, price: true, minutesIncluded: true } },
        _count: { select: { leads: true, calls: true, campaigns: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json(tenants)
  } catch (err) { next(err) }
})

// GET /api/admin/tenants/:id
router.get('/tenants/:id', async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        phoneNumbers: true,
        users: { select: { id: true, name: true, email: true, role: true, lastLoginAt: true } },
        scripts: { orderBy: { createdAt: 'desc' } },
        campaigns: { include: { _count: { select: { leads: true, calls: true } } }, orderBy: { createdAt: 'desc' } },
        _count: { select: { leads: true, calls: true } }
      }
    })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
    res.json(tenant)
  } catch (err) { next(err) }
})

// POST /api/admin/tenants — create a new client
router.post('/tenants', async (req, res, next) => {
  try {
    const {
      name, slug, ownerName, ownerEmail, ownerPassword,
      ratePerMinute, primaryColor, domain
    } = req.body

    if (!name || !slug || !ownerEmail || !ownerPassword)
      return res.status(400).json({ error: 'name, slug, ownerEmail, ownerPassword required' })

    const passwordHash = await bcrypt.hash(ownerPassword, 12)

    const tenant = await prisma.tenant.create({
      data: {
        name, slug,
        ownerName: ownerName || name,
        ownerEmail,
        ratePerMinute: ratePerMinute || 0.30,
        primaryColor: primaryColor || '#1a2b4a',
        domain: domain || null,
        users: {
          create: {
            email: ownerEmail,
            passwordHash,
            name: ownerName || name,
            role: 'OWNER'
          }
        }
      },
      include: { users: true }
    })

    res.status(201).json(tenant)
  } catch (err) { next(err) }
})

// PATCH /api/admin/tenants/:id
router.patch('/tenants/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'status', 'ratePerMinute', 'primaryColor', 'domain', 'logoUrl']
    const data = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) data[k] = req.body[k] })

    // planId: allow explicit null to unassign, or a string ID to assign
    if (req.body.planId !== undefined) {
      data.planId = req.body.planId || null
    }

    // clonedVoiceId: admin can assign any ElevenLabs voice ID directly (null to clear)
    if (req.body.clonedVoiceId !== undefined) {
      data.clonedVoiceId   = req.body.clonedVoiceId   || null
      data.clonedVoiceName = req.body.clonedVoiceName || null
    }

    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data,
      include: { plan: { select: { id: true, name: true, price: true, minutesIncluded: true } } }
    })
    res.json(tenant)
  } catch (err) { next(err) }
})

// POST /api/admin/tenants/:id/logo — upload/replace company logo
router.post('/tenants/:id/logo', logoUpload.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const ext      = path.extname(req.file.originalname).toLowerCase() || '.png'
    const filename = `${req.params.id}-${Date.now()}${ext}`
    const logoUrl  = await storageService.uploadFile({
      buffer:   req.file.buffer,
      mimetype: req.file.mimetype,
      filename,
      folder:   'logos'
    })
    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data: { logoUrl }
    })
    res.json(tenant)
  } catch (err) { next(err) }
})

// ── PHONE NUMBER MANAGEMENT ────────────────────────────

const phoneProviders = require('../services/phoneProviders')

// GET /api/admin/numbers — all numbers across all tenants
router.get('/numbers', async (req, res, next) => {
  try {
    const numbers = await prisma.tenantPhone.findMany({
      include: { tenant: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' }
    })
    res.json(numbers)
  } catch (err) { next(err) }
})

// GET /api/admin/numbers/search?provider=TWILIO&country=US&areaCode=212
router.get('/numbers/search', async (req, res, next) => {
  try {
    const { provider = 'TWILIO', country = 'US', limit } = req.query
    // Strip any "undefined" strings that the frontend may accidentally send
    const clean = (v) => (v && v !== 'undefined' && v !== 'null' ? v : undefined)
    const areaCode = clean(req.query.areaCode)
    const contains = clean(req.query.contains)
    const pattern  = clean(req.query.pattern)

    const results = await phoneProviders.searchAvailable({
      provider: provider.toUpperCase(),
      country: country.toUpperCase(),
      areaCode, contains, pattern,
      limit: Math.min(parseInt(limit) || 20, 50)
    })
    res.json(results)
  } catch (err) { next(err) }
})

// POST /api/admin/numbers/buy — buy from provider, register in Vapi, assign to tenant
router.post('/numbers/buy', async (req, res, next) => {
  try {
    const { number, provider = 'TWILIO', country, tenantId, isDefault } = req.body
    if (!number || !tenantId)
      return res.status(400).json({ error: 'number and tenantId are required' })

    const { twilioSid, plivoUuid, vapiNumberId } = await phoneProviders.buyAndRegister({
      provider: provider.toUpperCase(),
      number
    })

    if (isDefault) {
      await prisma.tenantPhone.updateMany({
        where: { tenantId, country, isDefault: true },
        data: { isDefault: false }
      })
    }

    const phone = await prisma.tenantPhone.create({
      data: {
        tenantId,
        number,
        friendlyName: number,
        country: country?.toUpperCase() || 'US',
        provider: provider.toUpperCase(),
        twilioSid,
        plivoUuid,
        vapiNumberId,
        isDefault: isDefault || false,
      },
      include: { tenant: { select: { id: true, name: true } } }
    })

    res.status(201).json(phone)
  } catch (err) { next(err) }
})

// GET /api/admin/tenants/:id/numbers
router.get('/tenants/:id/numbers', async (req, res, next) => {
  try {
    const numbers = await prisma.tenantPhone.findMany({
      where: { tenantId: req.params.id }
    })
    res.json(numbers)
  } catch (err) { next(err) }
})

// POST /api/admin/tenants/:id/numbers — manually assign (no auto-buy)
router.post('/tenants/:id/numbers', async (req, res, next) => {
  try {
    const { number, friendlyName, country, provider, twilioSid, plivoUuid, vapiNumberId, isDefault } = req.body
    if (!number || !country)
      return res.status(400).json({ error: 'number and country required' })

    if (isDefault) {
      await prisma.tenantPhone.updateMany({
        where: { tenantId: req.params.id, country, isDefault: true },
        data: { isDefault: false }
      })
    }

    const phone = await prisma.tenantPhone.create({
      data: {
        tenantId: req.params.id,
        number, friendlyName: friendlyName || number,
        country, provider: provider || 'TWILIO',
        twilioSid, plivoUuid, vapiNumberId,
        isDefault: isDefault || false
      }
    })
    res.status(201).json(phone)
  } catch (err) { next(err) }
})

// DELETE /api/admin/numbers/:numberId
router.delete('/numbers/:numberId', async (req, res, next) => {
  try {
    await prisma.tenantPhone.delete({ where: { id: req.params.numberId } })
    res.json({ message: 'Number removed' })
  } catch (err) { next(err) }
})

// DELETE /api/admin/tenants/:tenantId/numbers/:numberId (backwards compat)
router.delete('/tenants/:tenantId/numbers/:numberId', async (req, res, next) => {
  try {
    await prisma.tenantPhone.delete({ where: { id: req.params.numberId } })
    res.json({ message: 'Number removed' })
  } catch (err) { next(err) }
})

// ── SCRIPT REVIEW ──────────────────────────────────────

// GET /api/admin/scripts/pending
router.get('/scripts/pending', async (req, res, next) => {
  try {
    const scripts = await prisma.script.findMany({
      where: { status: 'PENDING_REVIEW' },
      include: { tenant: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' }
    })
    res.json(scripts)
  } catch (err) { next(err) }
})

// POST /api/admin/scripts/:id/approve
router.post('/scripts/:id/approve', async (req, res, next) => {
  try {
    const scriptService = require('../services/script')
    const script = await prisma.script.findUnique({ where: { id: req.params.id } })
    if (!script) return res.status(404).json({ error: 'Script not found' })

    // Compile the system prompt from the client's plain-English script
    const compiledPrompt = scriptService.compileSystemPrompt(script)

    // Create/update assistant in Vapi with compiled prompt
    const vapiAssistantId = await vapiService.upsertAssistant({
      name: `${script.agentName} — ${script.id}`,
      systemPrompt: compiledPrompt,
      voiceId: script.voiceId,
      agentName: script.agentName,
      language: script.language || 'en'
    })

    const updated = await prisma.script.update({
      where: { id: req.params.id },
      data: {
        status: 'APPROVED',
        compiledPrompt: JSON.stringify({ vapiAssistantId, prompt: compiledPrompt }),
        reviewedBy: req.user.id,
        reviewedAt: new Date(),
        reviewNote: null,
        isActive: true
      }
    })
    res.json(updated)
  } catch (err) { next(err) }
})

// POST /api/admin/scripts/:id/reject
router.post('/scripts/:id/reject', async (req, res, next) => {
  try {
    const { note } = req.body
    if (!note) return res.status(400).json({ error: 'Rejection note required' })

    const updated = await prisma.script.update({
      where: { id: req.params.id },
      data: {
        status: 'REJECTED',
        reviewNote: note,
        reviewedBy: req.user.id,
        reviewedAt: new Date(),
        isActive: false
      }
    })
    res.json(updated)
  } catch (err) { next(err) }
})

// GET /api/admin/scripts/reviewed
router.get('/scripts/reviewed', async (req, res, next) => {
  try {
    const scripts = await prisma.script.findMany({
      where: { status: { in: ['APPROVED', 'REJECTED'] } },
      include: { tenant: { select: { id: true, name: true } } },
      orderBy: { reviewedAt: 'desc' },
      take: 50
    })
    res.json(scripts)
  } catch (err) { next(err) }
})

// ── PLATFORM BILLING OVERVIEW ──────────────────────────

// GET /api/admin/billing/summary
router.get('/billing/summary', async (req, res, next) => {
  try {
    const { month } = req.query  // "2026-06"
    const start = month ? new Date(`${month}-01`) : startOfMonth()
    const end = month ? new Date(new Date(`${month}-01`).setMonth(new Date(`${month}-01`).getMonth() + 1)) : new Date()

    const summary = await prisma.usageLog.groupBy({
      by: ['tenantId'],
      where: { createdAt: { gte: start, lt: end } },
      _sum: { minutes: true, amount: true }
    })

    const tenantIds = summary.map(s => s.tenantId)
    const tenants = await prisma.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true, ratePerMinute: true, stripeCustomerId: true, plan: { select: { id: true, name: true } } }
    })

    const tenantMap = Object.fromEntries(tenants.map(t => [t.id, t]))
    const result = summary.map(s => ({
      tenant: tenantMap[s.tenantId],
      totalMinutes: s._sum.minutes,
      totalRevenue: s._sum.amount,
      platformCost: s._sum.minutes * parseFloat(process.env.PLATFORM_COST_PER_MINUTE || 0.12),
      grossProfit: s._sum.amount - (s._sum.minutes * parseFloat(process.env.PLATFORM_COST_PER_MINUTE || 0.12))
    }))

    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/admin/billing/invoice — admin generates invoice for a specific tenant
router.post('/billing/invoice', async (req, res, next) => {
  try {
    const { tenantId, month } = req.body
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' })

    const Stripe = require('stripe')
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY)

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { plan: true }
    })
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' })
    if (!tenant.stripeCustomerId) {
      return res.status(400).json({ error: 'Tenant has no Stripe payment method on file' })
    }

    const billMonth = month || new Date().toISOString().slice(0, 7)
    const [year, mo] = billMonth.split('-').map(Number)
    const from = new Date(year, mo - 1, 1)
    const to   = new Date(year, mo, 1)

    const agg = await prisma.usageLog.aggregate({
      where: { tenantId, createdAt: { gte: from, lt: to } },
      _sum: { minutes: true, amount: true }
    })

    const totalMinutes = agg._sum.minutes || 0
    const totalAmount  = Math.round((agg._sum.amount || 0) * 100)

    if (totalAmount === 0) {
      return res.status(400).json({ error: 'No usage to invoice for this period' })
    }

    const monthLabel = new Date(year, mo - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const planLabel  = tenant.plan ? ` (${tenant.plan.name} plan)` : ''
    const desc = `VoCallM — ${monthLabel}${planLabel}: ${totalMinutes.toFixed(1)} min @ $${tenant.ratePerMinute}/min`

    await stripe.invoiceItems.create({
      customer:    tenant.stripeCustomerId,
      amount:      totalAmount,
      currency:    'usd',
      description: desc,
    })

    const invoice = await stripe.invoices.create({
      customer:          tenant.stripeCustomerId,
      auto_advance:      true,
      collection_method: 'charge_automatically',
      description:       `VoCallM usage — ${monthLabel}`,
    })

    const finalised = await stripe.invoices.finalizeInvoice(invoice.id)

    console.log(`[admin/billing] Invoice ${finalised.id} created for ${tenant.name} — $${(totalAmount/100).toFixed(2)}`)

    res.json({
      invoiceId:   finalised.id,
      amount:      finalised.amount_due / 100,
      status:      finalised.status,
      hostedUrl:   finalised.hosted_invoice_url,
      pdfUrl:      finalised.invoice_pdf,
      description: desc,
    })
  } catch (err) { next(err) }
})

// GET /api/admin/notifications — aggregated activity feed for admin header
router.get('/notifications', async (req, res, next) => {
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const [pendingScripts, newTenants, recentBookings] = await Promise.all([
      prisma.script.findMany({
        where: { status: 'PENDING_REVIEW' },
        select: { id: true, name: true, createdAt: true, tenant: { select: { name: true } } },
        orderBy: { createdAt: 'desc' }, take: 10
      }),
      prisma.tenant.findMany({
        where: { createdAt: { gte: since7d } },
        select: { id: true, name: true, ownerEmail: true, createdAt: true },
        orderBy: { createdAt: 'desc' }, take: 5
      }),
      prisma.call.count({
        where: { outcome: 'BOOKED', createdAt: { gte: since24h } }
      })
    ])

    const items = [
      ...pendingScripts.map(s => ({
        id: `script-${s.id}`,
        type: 'SCRIPT_REVIEW',
        title: `Script review needed`,
        body: `"${s.name}" from ${s.tenant.name}`,
        at: s.createdAt,
        link: '/admin/scripts',
      })),
      ...newTenants.map(t => ({
        id: `tenant-${t.id}`,
        type: 'NEW_CLIENT',
        title: 'New client signed up',
        body: `${t.name} · ${t.ownerEmail}`,
        at: t.createdAt,
        link: '/admin/clients',
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 12)

    res.json({ items, recentBookings, unreadCount: pendingScripts.length + newTenants.length })
  } catch (err) { next(err) }
})

// ── PLAN MANAGEMENT ────────────────────────────────────

// GET /api/admin/plans
router.get('/plans', async (req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({ orderBy: { displayOrder: 'asc' } })
    res.json(plans)
  } catch (err) { next(err) }
})

// POST /api/admin/plans
router.post('/plans', async (req, res, next) => {
  try {
    const { name, blurb, price, minutesIncluded, features, isActive, isPopular, displayOrder } = req.body
    if (!name || price === undefined || !features)
      return res.status(400).json({ error: 'name, price and features are required' })
    const plan = await prisma.plan.create({
      data: {
        name,
        blurb: blurb || null,
        price: parseFloat(price),
        minutesIncluded: parseInt(minutesIncluded) || 0,
        features: Array.isArray(features) ? features : JSON.parse(features),
        isActive:     isActive     !== undefined ? Boolean(isActive)     : true,
        isPopular:    isPopular    !== undefined ? Boolean(isPopular)    : false,
        displayOrder: displayOrder !== undefined ? parseInt(displayOrder) : 0,
      }
    })
    res.status(201).json(plan)
  } catch (err) { next(err) }
})

// PATCH /api/admin/plans/:id
router.patch('/plans/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'blurb', 'price', 'minutesIncluded', 'features', 'isActive', 'isPopular', 'displayOrder']
    const data = {}
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        if (k === 'price')           data[k] = parseFloat(req.body[k])
        else if (k === 'minutesIncluded' || k === 'displayOrder') data[k] = parseInt(req.body[k])
        else if (k === 'isActive' || k === 'isPopular')           data[k] = Boolean(req.body[k])
        else                                                        data[k] = req.body[k]
      }
    })
    const plan = await prisma.plan.update({ where: { id: req.params.id }, data })
    res.json(plan)
  } catch (err) { next(err) }
})

// DELETE /api/admin/plans/:id
router.delete('/plans/:id', async (req, res, next) => {
  try {
    const count = await prisma.tenant.count({ where: { planId: req.params.id } })
    if (count > 0) return res.status(409).json({ error: `${count} tenant(s) are on this plan. Deactivate it instead.` })
    await prisma.plan.delete({ where: { id: req.params.id } })
    res.json({ message: 'Plan deleted' })
  } catch (err) { next(err) }
})

// ── HELPERS ────────────────────────────────────────────
function startOfDay() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}
function startOfMonth() {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d
}

module.exports = router
