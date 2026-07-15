// backend/src/routes/admin.js
// All routes here require super admin auth (Wayne E Solutions team only)
const router = require('express').Router()
const bcrypt = require('bcryptjs')
const path   = require('path')
const multer = require('multer')
const prisma = require('../lib/prisma')
const { requireAdmin } = require('../middleware/auth')
const vapiService  = require('../services/vapi')
const storageService = require('../services/storage')
const { sendClientWelcome } = require('../services/email')
const { submitTemplateToMeta } = require('../services/waTemplates')

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
    const [tenantCount, callsToday, minutesToday, meetingsToday, inboundCallsToday] = await Promise.all([
      prisma.tenant.count({ where: { status: 'ACTIVE' } }),
      prisma.call.count({ where: { createdAt: { gte: startOfDay() } } }),
      prisma.call.aggregate({
        where: { createdAt: { gte: startOfDay() } },
        _sum: { billedMinutes: true }
      }),
      prisma.call.count({
        where: { outcome: 'BOOKED', createdAt: { gte: startOfDay() } }
      }),
      prisma.inboundCall.count({ where: { createdAt: { gte: startOfDay() } } })
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
      revenueToday: revenueToday._sum.amount || 0,
      inboundCallsToday
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
        _count: { select: { leads: true, calls: true, campaigns: true, inboundCalls: true, inboundAssistants: true } }
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
        _count: { select: { leads: true, calls: true, inboundCalls: true, inboundAssistants: true } }
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

    // Check for duplicate email or slug before attempting create
    const [emailTaken, slugTaken] = await Promise.all([
      prisma.tenant.findUnique({ where: { ownerEmail } }),
      prisma.tenant.findUnique({ where: { slug } }),
    ])
    if (emailTaken) return res.status(409).json({ error: `A client with email "${ownerEmail}" already exists.` })
    if (slugTaken)  return res.status(409).json({ error: `The slug "${slug}" is already in use. Choose a different one.` })

    // Also check the TenantUser table (self-registered users share the same email pool)
    const userTaken = await prisma.tenantUser.findFirst({ where: { email: ownerEmail } })
    if (userTaken) return res.status(409).json({ error: `A user with email "${ownerEmail}" already exists.` })

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

    // Send welcome email with credentials (non-blocking — don't fail creation if email fails)
    sendClientWelcome(ownerEmail, ownerName || name, name, ownerPassword).catch(e =>
      console.error('[email] Failed to send client welcome:', e.message)
    )

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
    const phone = await prisma.tenantPhone.findUnique({ where: { id: req.params.numberId } })
    if (phone) {
      await phoneProviders.releaseNumber({
        provider: phone.provider, twilioSid: phone.twilioSid,
        plivoUuid: phone.plivoUuid, vapiNumberId: phone.vapiNumberId
      })
    }
    await prisma.tenantPhone.delete({ where: { id: req.params.numberId } })
    res.json({ message: 'Number removed' })
  } catch (err) { next(err) }
})

// DELETE /api/admin/tenants/:tenantId/numbers/:numberId (backwards compat)
router.delete('/tenants/:tenantId/numbers/:numberId', async (req, res, next) => {
  try {
    const phone = await prisma.tenantPhone.findUnique({ where: { id: req.params.numberId } })
    if (phone) {
      await phoneProviders.releaseNumber({
        provider: phone.provider, twilioSid: phone.twilioSid,
        plivoUuid: phone.plivoUuid, vapiNumberId: phone.vapiNumberId
      })
    }
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

    console.log('[approve] scriptId=', script.id, '| callType=', script.callType, '| callerOrg=', script.callerOrg, '| language=', script.language)
    console.log('[approve] firstMessage=', script.callType === 'survey' ? scriptService.buildSurveyFirstMessage(script) : '(sales — using default)')

    // Create/update assistant in Vapi with compiled prompt
    // FIX BUG-F: agentGender was never passed here, so upsertAssistant's
    // default ('female') silently overrode whatever the client actually
    // configured. Every approved assistant used female Hindi/Punjabi verb
    // forms regardless of the script's real agentGender setting.
    const vapiAssistantId = await vapiService.upsertAssistant({
      name: `${script.agentName} — ${script.id}`,
      systemPrompt: compiledPrompt,
      voiceId: script.voiceId,
      agentName: script.agentName,
      language: script.language || 'en',
      agentGender: script.agentGender || 'female',
      callType: script.callType || 'sales',
      maxCallDuration: script.maxCallDuration || 180,
      firstMessageOverride: script.callType === 'survey' ? scriptService.buildSurveyFirstMessage(script) : undefined
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

// POST /api/admin/scripts/:id/resync — re-push already-approved script to Vapi without changing approval status
router.post('/scripts/:id/resync', async (req, res, next) => {
  try {
    const scriptService = require('../services/script')
    const script = await prisma.script.findUnique({ where: { id: req.params.id } })
    if (!script) return res.status(404).json({ error: 'Script not found' })

    // Extract existing Vapi assistant ID so we PATCH it rather than POST a duplicate
    let existingAssistantId = null
    try {
      const stored = JSON.parse(script.compiledPrompt || '{}')
      existingAssistantId = stored.vapiAssistantId || null
    } catch {}

    console.log('[resync] scriptId=', script.id, 'existingAssistantId=', existingAssistantId, 'agentGender=', script.agentGender)

    const compiledPrompt = scriptService.compileSystemPrompt(script)
    // FIX BUG-F: same missing agentGender as /approve above — resync is the
    // button the team actually clicks to push a fix live, so this was the
    // reason re-syncing never changed the agent's gendered speech.
    const vapiAssistantId = await vapiService.upsertAssistant({
      name: `${script.agentName} — ${script.id}`,
      systemPrompt: compiledPrompt,
      voiceId: script.voiceId,
      agentName: script.agentName,
      language: script.language || 'en',
      agentGender: script.agentGender || 'female',
      callType: script.callType || 'sales',
      existingAssistantId,
      maxCallDuration: script.maxCallDuration || 180,
      firstMessageOverride: script.callType === 'survey' ? scriptService.buildSurveyFirstMessage(script) : undefined
    })

    const updated = await prisma.script.update({
      where: { id: req.params.id },
      data: { compiledPrompt: JSON.stringify({ vapiAssistantId, prompt: compiledPrompt }) }
    })
    res.json(updated)
  } catch (err) {
    // Surface the actual Vapi error detail to help debug
    const detail = err.response?.data || err.message
    console.error('[resync] Vapi error:', JSON.stringify(detail))
    res.status(500).json({ error: typeof detail === 'object' ? JSON.stringify(detail) : detail })
  }
})

// POST /api/admin/scripts/resync-all — re-push ALL approved scripts to Vapi (e.g. after credential rotation)
router.post('/scripts/resync-all', async (req, res, next) => {
  try {
    const scriptService = require('../services/script')
    const scripts = await prisma.script.findMany({ where: { status: 'APPROVED' } })

    let synced = 0, failed = 0
    const errors = []

    for (const script of scripts) {
      try {
        let existingAssistantId = null
        try {
          const stored = JSON.parse(script.compiledPrompt || '{}')
          existingAssistantId = stored.vapiAssistantId || null
        } catch {}

        const compiledPrompt = scriptService.compileSystemPrompt(script)
        const vapiAssistantId = await vapiService.upsertAssistant({
          name: `${script.agentName} — ${script.id}`,
          systemPrompt: compiledPrompt,
          voiceId: script.voiceId,
          agentName: script.agentName,
          language: script.language || 'en',
          agentGender: script.agentGender || 'female',
          callType: script.callType || 'sales',
          existingAssistantId,
          maxCallDuration: script.maxCallDuration || 180,
          firstMessageOverride: script.callType === 'survey' ? scriptService.buildSurveyFirstMessage(script) : undefined
        })

        await prisma.script.update({
          where: { id: script.id },
          data: { compiledPrompt: JSON.stringify({ vapiAssistantId, prompt: compiledPrompt }) }
        })
        synced++
      } catch (err) {
        failed++
        const detail = err.response?.data || err.message
        errors.push({ scriptId: script.id, name: script.name, error: typeof detail === 'object' ? JSON.stringify(detail) : detail })
        console.error('[resync-all] Failed for script', script.id, detail)
      }
    }

    res.json({ total: scripts.length, synced, failed, errors })
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
    const end   = month
      ? new Date(new Date(`${month}-01`).setMonth(new Date(`${month}-01`).getMonth() + 1))
      : new Date()

    // Usage logs for the period
    const usage = await prisma.usageLog.groupBy({
      by: ['tenantId'],
      where: { createdAt: { gte: start, lt: end } },
      _sum: { minutes: true, amount: true }
    })
    const usageMap = Object.fromEntries(usage.map(s => [s.tenantId, s]))
    const usageTenantIds = usage.map(s => s.tenantId)

    // Include tenants with active paid subscriptions even if they had no calls this month
    const tenants = await prisma.tenant.findMany({
      where: {
        OR: [
          { id: { in: usageTenantIds } },
          { stripeSubscriptionId: { not: null } }
        ]
      },
      select: {
        id: true, name: true, ratePerMinute: true,
        stripeCustomerId: true, stripeSubscriptionId: true,
        planExpiresAt: true,
        plan: { select: { id: true, name: true, price: true, minutesIncluded: true } }
      }
    })

    const costPerMin = parseFloat(process.env.PLATFORM_COST_PER_MINUTE || '0.12')

    const result = tenants.map(tenant => {
      const u = usageMap[tenant.id]
      const totalMinutes  = u?._sum.minutes || 0
      const usageRevenue  = u?._sum.amount  || 0

      // Subscription revenue = plan price if the subscription was active during this period
      // A subscription is "active for this month" if stripeSubscriptionId is set and
      // planExpiresAt is either null (never expires) or falls after the period start
      const subscriptionActive =
        !!tenant.stripeSubscriptionId &&
        !!tenant.plan &&
        (tenant.plan.price || 0) > 0 &&
        (!tenant.planExpiresAt || new Date(tenant.planExpiresAt) > start)

      const subscriptionRevenue = subscriptionActive ? (tenant.plan.price || 0) : 0
      const totalRevenue  = usageRevenue + subscriptionRevenue
      const platformCost  = totalMinutes * costPerMin
      const grossProfit   = totalRevenue - platformCost

      return {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          ratePerMinute: tenant.ratePerMinute,
          stripeCustomerId: tenant.stripeCustomerId,
          stripeSubscriptionId: tenant.stripeSubscriptionId || null,
          planExpiresAt: tenant.planExpiresAt || null,
          plan: tenant.plan ? {
            id: tenant.plan.id,
            name: tenant.plan.name,
            price: tenant.plan.price,
            minutesIncluded: tenant.plan.minutesIncluded,
          } : null
        },
        totalMinutes,
        usageRevenue,
        subscriptionRevenue,
        totalRevenue,
        platformCost,
        grossProfit
      }
    })

    // Sort: most revenue first
    result.sort((a, b) => b.totalRevenue - a.totalRevenue)

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

    const periodLabel = new Date(year, mo - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const planLabel   = tenant.plan ? tenant.plan.name : 'Pay-as-you-go'
    const desc = `AI Calling — ${totalMinutes.toFixed(1)} min @ $${parseFloat(tenant.ratePerMinute).toFixed(2)}/min (${periodLabel})`

    // Ensure Stripe customer reflects current company details
    await stripe.customers.update(tenant.stripeCustomerId, {
      name:        tenant.name,
      email:       tenant.ownerEmail,
      description: `Quor client — ${tenant.ownerName || tenant.name}`,
      metadata:    { tenantId: tenant.id }
    })

    await stripe.invoiceItems.create({
      customer:    tenant.stripeCustomerId,
      amount:      totalAmount,
      currency:    'usd',
      description: desc,
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
        { name: 'Minutes used',   value: `${totalMinutes.toFixed(1)} min` },
        { name: 'Rate',           value: `$${parseFloat(tenant.ratePerMinute).toFixed(2)}/min` },
      ],
      footer: 'Quor by Wayne E Solutions · support@vocallm.com · vocallm.com\nThank you for your business.',
      metadata: { tenantId, month: billMonth }
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

// ── PLATFORM CREDITS & ALERTS ─────────────────────────

const { getCredits } = require('../services/platformCredits')

// GET /api/admin/platform-credits — live credit snapshot (5-min in-memory cache)
router.get('/platform-credits', async (req, res, next) => {
  try {
    const data = await getCredits()
    res.json(data)
  } catch (err) { next(err) }
})

// GET /api/admin/alerts — all alerts, newest first
router.get('/alerts', async (req, res, next) => {
  try {
    if (!prisma.adminAlert) return res.json({ alerts: [], unreadCount: 0 })
    const alerts = await prisma.adminAlert.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    const unreadCount = alerts.filter(a => !a.isRead).length
    res.json({ alerts, unreadCount })
  } catch (err) { next(err) }
})

// PATCH /api/admin/alerts/:id/read — mark one alert read
router.patch('/alerts/:id/read', async (req, res, next) => {
  try {
    if (!prisma.adminAlert) return res.json({ ok: true })
    await prisma.adminAlert.update({ where: { id: req.params.id }, data: { isRead: true } })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// POST /api/admin/alerts/mark-all-read — dismiss all unread alerts
router.post('/alerts/mark-all-read', async (req, res, next) => {
  try {
    if (!prisma.adminAlert) return res.json({ ok: true })
    await prisma.adminAlert.updateMany({ where: { isRead: false }, data: { isRead: true } })
    res.json({ ok: true })
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

// GET /api/admin/debug/lead-status-counts — see how many leads exist per status (all tenants)
router.get('/debug/lead-status-counts', async (req, res, next) => {
  try {
    const rows = await prisma.lead.groupBy({
      by: ['status'],
      _count: { _all: true },
      orderBy: { _count: { status: 'desc' } }
    })
    const total = await prisma.lead.count()
    res.json({
      total,
      byStatus: Object.fromEntries(rows.map(r => [r.status, r._count._all]))
    })
  } catch (err) { next(err) }
})

// POST /api/admin/backfill-wa-opted-in
// One-time (idempotent) backfill: scan every Lead with status=BOOKED and create
// a WaContact (OPTED_IN) in that tenant's auto "Quor Opted-In" list.
// Safe to run multiple times — skips contacts that already exist.
router.post('/backfill-wa-opted-in', async (req, res, next) => {
  try {
    const WA_AUTO_LIST_NAME = 'Quor Opted-In'

    const bookedLeads = await prisma.lead.findMany({
      where: { status: 'BOOKED' },
      include: {
        calls: {
          where: { outcome: 'BOOKED' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })

    let added = 0, skipped = 0
    const errors = []
    // Cache per-tenant list id so we don't hit DB on every row
    const listCache = {}

    for (const lead of bookedLeads) {
      if (!lead.phone) { skipped++; continue }

      try {
        if (!listCache[lead.tenantId]) {
          let list = await prisma.waContactList.findFirst({
            where: { tenantId: lead.tenantId, name: WA_AUTO_LIST_NAME },
          })
          if (!list) {
            list = await prisma.waContactList.create({
              data: { tenantId: lead.tenantId, name: WA_AUTO_LIST_NAME, totalContacts: 0 },
            })
          }
          listCache[lead.tenantId] = list
        }

        const list = listCache[lead.tenantId]

        const existing = await prisma.waContact.findFirst({
          where: { contactListId: list.id, phone: lead.phone },
        })

        if (existing) { skipped++; continue }

        const bookedCall = lead.calls[0]

        await prisma.$transaction([
          prisma.waContact.create({
            data: {
              contactListId:     list.id,
              tenantId:          lead.tenantId,
              phone:             lead.phone,
              fullName:          lead.name    || null,
              businessName:      lead.company || null,
              optInStatus:       'OPTED_IN',
              optInSource:       'vocallm_call_backfill',
              optInTimestamp:    lead.meetingBookedAt || lead.updatedAt,
              optInCallId:       bookedCall?.vapiCallId || bookedCall?.id || null,
              optInRecordingUrl: bookedCall?.recordingUrl || null,
            },
          }),
          prisma.waContactList.update({
            where: { id: list.id },
            data:  { totalContacts: { increment: 1 } },
          }),
        ])

        added++
      } catch (err) {
        errors.push(`Lead ${lead.id} (${lead.phone}): ${err.message}`)
      }
    }

    // Recalculate totalContacts to fix any drift from the cache
    for (const list of Object.values(listCache)) {
      const count = await prisma.waContact.count({ where: { contactListId: list.id } })
      await prisma.waContactList.update({ where: { id: list.id }, data: { totalContacts: count } })
    }

    console.log(`[admin] WA backfill complete — added=${added} skipped=${skipped} errors=${errors.length}`)
    res.json({ totalBooked: bookedLeads.length, added, skipped, errors })
  } catch (err) { next(err) }
})

// POST /api/admin/calls/cleanup-stale — immediately mark stuck calls as completed + reset bogus durations
router.post('/calls/cleanup-stale', async (req, res, next) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000) // 30 min

    // 1. Mark still-stuck IN_PROGRESS calls as NO_ANSWER
    const stale = await prisma.call.findMany({
      where: { status: { in: ['IN_PROGRESS', 'RINGING', 'INITIATED'] }, createdAt: { lt: cutoff } }
    })
    for (const call of stale) {
      await prisma.call.update({
        where: { id: call.id },
        data: { status: 'COMPLETED', outcome: 'NO_ANSWER', durationSeconds: 0, endedAt: new Date() }
      }).catch(() => {})
      await prisma.lead.update({
        where: { id: call.leadId },
        data: { status: 'NO_ANSWER' }
      }).catch(() => {})
    }

    // 2. Reset bogus durations: NO_ANSWER calls shouldn't have duration > 10min
    const bogus = await prisma.call.updateMany({
      where: { outcome: 'NO_ANSWER', durationSeconds: { gt: 600 } },
      data: { durationSeconds: 0 }
    })

    res.json({ staleCleaned: stale.length, bogusReset: bogus.count })
  } catch (err) { next(err) }
})

// ── WHATSAPP TEMPLATE REVIEW ───────────────────────────────────────────────────

// GET /api/admin/wa-templates — all pending + recently submitted
router.get('/wa-templates', async (req, res, next) => {
  try {
    const { status } = req.query
    const where = status ? { status } : { status: { in: ['PENDING_ADMIN', 'SUBMITTED_TO_META', 'APPROVED', 'META_REJECTED', 'ADMIN_REJECTED'] } }
    const templates = await prisma.waTemplateRequest.findMany({
      where,
      include: { tenant: { select: { id: true, name: true, ownerEmail: true } } },
      orderBy: { createdAt: 'desc' },
    })
    res.json(templates)
  } catch (err) { next(err) }
})

// POST /api/admin/wa-templates/:id/approve — submit to Meta
router.post('/wa-templates/:id/approve', async (req, res, next) => {
  try {
    const tpl = await prisma.waTemplateRequest.findUnique({ where: { id: req.params.id } })
    if (!tpl) return res.status(404).json({ error: 'Template not found' })
    if (tpl.status !== 'PENDING_ADMIN') return res.status(400).json({ error: `Template is ${tpl.status}, not PENDING_ADMIN` })

    const metaRes = await submitTemplateToMeta(tpl.id)
    const updated = await prisma.waTemplateRequest.findUnique({ where: { id: tpl.id } })
    res.json({ template: updated, meta: metaRes })
  } catch (err) { next(err) }
})

// POST /api/admin/wa-templates/:id/reject — reject with admin note
router.post('/wa-templates/:id/reject', async (req, res, next) => {
  try {
    const { note } = req.body
    const tpl = await prisma.waTemplateRequest.findUnique({ where: { id: req.params.id } })
    if (!tpl) return res.status(404).json({ error: 'Template not found' })

    const updated = await prisma.waTemplateRequest.update({
      where: { id: tpl.id },
      data:  { status: 'ADMIN_REJECTED', adminNote: note?.trim() || null },
    })
    res.json(updated)
  } catch (err) { next(err) }
})

// GET/PUT /api/admin/tenants/:id/wa-config — view / set per-tenant WABA credentials
router.get('/tenants/:id/wa-config', async (req, res, next) => {
  try {
    const cfg = await prisma.waTenantConfig.findUnique({ where: { tenantId: req.params.id } })
    res.json(cfg || {})
  } catch (err) { next(err) }
})

router.put('/tenants/:id/wa-config', async (req, res, next) => {
  try {
    const { wabaId, phoneNumberId, accessToken } = req.body
    const cfg = await prisma.waTenantConfig.upsert({
      where:  { tenantId: req.params.id },
      update: { wabaId: wabaId || null, phoneNumberId: phoneNumberId || null, accessToken: accessToken || null },
      create: { tenantId: req.params.id, wabaId: wabaId || null, phoneNumberId: phoneNumberId || null, accessToken: accessToken || null },
    })
    res.json(cfg)
  } catch (err) { next(err) }
})

module.exports = router
