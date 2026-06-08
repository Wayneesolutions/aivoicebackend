// backend/src/routes/scripts.js
const router = require('express').Router()
const multer = require('multer')
const pdfParse = require('pdf-parse')
const { PrismaClient } = require('@prisma/client')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const prisma = new PrismaClient()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// GET /api/scripts
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const scripts = await prisma.script.findMany({
      where: { tenantId: req.tenant.id },
      orderBy: { createdAt: 'desc' }
    })
    res.json(scripts)
  } catch (err) { next(err) }
})

// POST /api/scripts — client submits new script for approval
router.post('/', requireTenantOwner, async (req, res, next) => {
  try {
    const { name, companyInfo, servicesInfo, goalText, objections, agentName, voiceId } = req.body
    if (!companyInfo || !servicesInfo || !goalText)
      return res.status(400).json({ error: 'companyInfo, servicesInfo, and goalText required' })

    const script = await prisma.script.create({
      data: {
        tenantId:    req.tenant.id,
        name:        name || 'New script',
        companyInfo, servicesInfo, goalText,
        objections:  objections || null,
        agentName:   agentName  || 'Alex',
        voiceId:     voiceId    || process.env.ELEVENLABS_DEFAULT_VOICE_ID,
        status:      'PENDING_REVIEW'
      }
    })
    res.status(201).json({ ...script, message: 'Script submitted for review. You will be notified when approved.' })
  } catch (err) { next(err) }
})

// POST /api/scripts/:id/faq — upload FAQ document
router.post('/:id/faq', requireTenantOwner, upload.single('file'), async (req, res, next) => {
  try {
    const script = await prisma.script.findFirst({ where: { id: req.params.id, tenantId: req.tenant.id } })
    if (!script) return res.status(404).json({ error: 'Script not found' })
    if (!req.file)  return res.status(400).json({ error: 'No file uploaded' })

    let faqText = ''
    if (req.file.mimetype === 'application/pdf') {
      const data = await pdfParse(req.file.buffer)
      faqText = data.text
    } else {
      faqText = req.file.buffer.toString('utf8')
    }

    // Truncate to 8000 chars — enough for the system prompt
    faqText = faqText.slice(0, 8000)

    await prisma.script.update({
      where: { id: req.params.id },
      data: { faqDocument: faqText, status: 'PENDING_REVIEW' }  // re-review after FAQ update
    })
    res.json({ message: 'FAQ uploaded. Script re-submitted for review.' })
  } catch (err) { next(err) }
})

module.exports = router


// ─────────────────────────────────────────────────────────────────────
// backend/src/routes/campaigns.js
// ─────────────────────────────────────────────────────────────────────
const campaignRouter = require('express').Router()
const { triggerCampaign, pauseTenant } = require('../workers/dialQueue')

campaignRouter.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { tenantId: req.tenant.id },
      include: {
        script: { select: { id: true, name: true, status: true, agentName: true } },
        _count: { select: { leads: true, calls: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json(campaigns)
  } catch (err) { next(err) }
})

campaignRouter.post('/', requireTenantOwner, async (req, res, next) => {
  try {
    const { name, scriptId, callFromHour, callToHour, timezone, callDays, maxAttempts, retryAfterHours } = req.body
    if (!name || !scriptId) return res.status(400).json({ error: 'name and scriptId required' })

    // Verify script belongs to this tenant and is approved
    const script = await prisma.script.findFirst({ where: { id: scriptId, tenantId: req.tenant.id } })
    if (!script) return res.status(404).json({ error: 'Script not found' })
    if (script.status !== 'APPROVED' && script.status !== 'LIVE')
      return res.status(400).json({ error: 'Script must be approved before creating a campaign' })

    const campaign = await prisma.campaign.create({
      data: {
        tenantId: req.tenant.id,
        scriptId, name,
        callFromHour:    callFromHour    || 9,
        callToHour:      callToHour      || 17,
        timezone:        timezone        || 'America/New_York',
        callDays:        callDays        || 'MON,TUE,WED,THU,FRI',
        maxAttempts:     maxAttempts     || 3,
        retryAfterHours: retryAfterHours || 24
      }
    })
    res.status(201).json(campaign)
  } catch (err) { next(err) }
})

campaignRouter.post('/:id/start', requireTenantOwner, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, tenantId: req.tenant.id } })
    if (!campaign) return res.status(404).json({ error: 'Not found' })

    await prisma.campaign.update({ where: { id: req.params.id }, data: { status: 'ACTIVE', startedAt: new Date() } })
    await triggerCampaign(req.params.id)
    res.json({ message: 'Campaign started' })
  } catch (err) { next(err) }
})

campaignRouter.post('/:id/pause', requireTenantOwner, async (req, res, next) => {
  try {
    await prisma.campaign.update({ where: { id: req.params.id, tenantId: req.tenant.id }, data: { status: 'PAUSED', pausedAt: new Date() } })
    res.json({ message: 'Campaign paused' })
  } catch (err) { next(err) }
})

module.exports.campaignRouter = campaignRouter


// ─────────────────────────────────────────────────────────────────────
// backend/src/routes/calls.js
// ─────────────────────────────────────────────────────────────────────
const callsRouter = require('express').Router()

callsRouter.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const { outcome, campaignId, page = 1, limit = 50 } = req.query
    const where = { tenantId: req.tenant.id }
    if (outcome)    where.outcome    = outcome
    if (campaignId) where.campaignId = campaignId

    const [calls, total] = await Promise.all([
      prisma.call.findMany({
        where,
        include: { lead: { select: { name: true, company: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit)
      }),
      prisma.call.count({ where })
    ])
    res.json({ calls, total })
  } catch (err) { next(err) }
})

callsRouter.get('/stats', requireTenantUser, async (req, res, next) => {
  try {
    const { from, to } = req.query
    const where = { tenantId: req.tenant.id }
    if (from || to) where.createdAt = {}
    if (from) where.createdAt.gte = new Date(from)
    if (to)   where.createdAt.lte = new Date(to)

    const [total, byOutcome, minutesData] = await Promise.all([
      prisma.call.count({ where }),
      prisma.call.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
      prisma.call.aggregate({ where, _sum: { billedMinutes: true, billedAmount: true } })
    ])

    const outcomeMap = Object.fromEntries(byOutcome.map(o => [o.outcome, o._count._all]))
    res.json({
      total,
      booked:       outcomeMap['BOOKED']       || 0,
      notInterested:outcomeMap['NOT_INTERESTED']|| 0,
      noAnswer:     outcomeMap['NO_ANSWER']     || 0,
      voicemail:    outcomeMap['VOICEMAIL']     || 0,
      callback:     outcomeMap['CALLBACK']      || 0,
      totalMinutes: minutesData._sum.billedMinutes || 0,
      totalBilled:  minutesData._sum.billedAmount  || 0,
      conversionRate: total > 0 ? ((outcomeMap['BOOKED'] || 0) / total * 100).toFixed(1) : 0
    })
  } catch (err) { next(err) }
})

callsRouter.get('/:id/transcript', requireTenantUser, async (req, res, next) => {
  try {
    const call = await prisma.call.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      include: { lead: true }
    })
    if (!call) return res.status(404).json({ error: 'Call not found' })
    res.json(call)
  } catch (err) { next(err) }
})

module.exports.callsRouter = callsRouter


// ─────────────────────────────────────────────────────────────────────
// backend/src/routes/tenant.js
// ─────────────────────────────────────────────────────────────────────
const tenantRouter = require('express').Router()

// GET /api/tenant/me — returns tenant config for the client portal
tenantRouter.get('/me', requireTenantUser, async (req, res) => {
  const { id, name, slug, domain, logoUrl, primaryColor, status, ratePerMinute, totalMinutes } = req.tenant
  res.json({ id, name, slug, domain, logoUrl, primaryColor, status, ratePerMinute, totalMinutes })
})

// PATCH /api/tenant/integrations — client connects their own calendar/CRM
tenantRouter.patch('/integrations', requireTenantOwner, async (req, res, next) => {
  try {
    const allowed = ['calcomApiKey', 'calcomEventTypeId', 'hubspotAccessToken', 'googleCalendarToken']
    const data = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) data[k] = req.body[k] })
    await prisma.tenant.update({ where: { id: req.tenant.id }, data })
    res.json({ message: 'Integrations updated' })
  } catch (err) { next(err) }
})

// GET /api/tenant/billing — usage history
tenantRouter.get('/billing', requireTenantUser, async (req, res, next) => {
  try {
    const { from, to } = req.query
    const { getUsageSummary } = require('../services/billing')
    const start = from ? new Date(from) : new Date(new Date().setDate(1))
    const end   = to   ? new Date(to)   : new Date()
    const summary = await getUsageSummary(req.tenant.id, start, end)
    res.json(summary)
  } catch (err) { next(err) }
})

module.exports.tenantRouter = tenantRouter
