// backend/src/routes/admin.js
// All routes here require super admin auth (Wayne Solutions team only)
const router = require('express').Router()
const bcrypt = require('bcryptjs')
const path = require('path')
const fs = require('fs')
const multer = require('multer')
const { PrismaClient } = require('@prisma/client')
const { requireAdmin } = require('../middleware/auth')
const vapiService = require('../services/vapi')
const prisma = new PrismaClient()

// ── Multer: logo uploads ───────────────────────────────────
const logoStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, '../../uploads/logos')
    fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.png'
    cb(null, `${req.params.id}-${Date.now()}${ext}`)
  }
})
const logoUpload = multer({
  storage: logoStorage,
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

// ── TENANT MANAGEMENT ──────────────────────────────────

// GET /api/admin/tenants
router.get('/tenants', async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      include: {
        phoneNumbers: true,
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

    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data })
    res.json(tenant)
  } catch (err) { next(err) }
})

// POST /api/admin/tenants/:id/logo — upload/replace company logo
router.post('/tenants/:id/logo', logoUpload.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const logoUrl = `/uploads/logos/${req.file.filename}`
    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data: { logoUrl }
    })
    res.json(tenant)
  } catch (err) { next(err) }
})

// ── PHONE NUMBER MANAGEMENT ────────────────────────────

// GET /api/admin/tenants/:id/numbers
router.get('/tenants/:id/numbers', async (req, res, next) => {
  try {
    const numbers = await prisma.tenantPhone.findMany({
      where: { tenantId: req.params.id }
    })
    res.json(numbers)
  } catch (err) { next(err) }
})

// POST /api/admin/tenants/:id/numbers — assign a phone number to a client
router.post('/tenants/:id/numbers', async (req, res, next) => {
  try {
    const { number, friendlyName, country, twilioSid, vapiNumberId, isDefault } = req.body
    if (!number || !country)
      return res.status(400).json({ error: 'number and country required' })

    // If setting as default, unset others for this country
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
        country, twilioSid, vapiNumberId,
        isDefault: isDefault || false
      }
    })
    res.status(201).json(phone)
  } catch (err) { next(err) }
})

// DELETE /api/admin/tenants/:tenantId/numbers/:numberId
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
      agentName: script.agentName
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
      select: { id: true, name: true, ratePerMinute: true }
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
