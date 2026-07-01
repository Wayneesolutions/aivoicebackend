// backend/src/routes/tenant.js
const router = require('express').Router()
const multer = require('multer')
const axios  = require('axios')
const bcrypt = require('bcryptjs')
const path   = require('path')
const prisma = require('../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const { getUsageSummary } = require('../services/billing')
const storageService = require('../services/storage')

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'))
    cb(null, true)
  }
})

const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('audio/')) cb(null, true)
    else cb(new Error('Audio files only (MP3, WAV, M4A, OGG, WebM)'))
  }
})

router.get('/me', requireTenantUser, async (req, res) => {
  const t = req.tenant

  // Check if admin has completed WA setup for this tenant
  const waConfig = await prisma.waTenantConfig.findUnique({ where: { tenantId: t.id } })

  res.json({
    id: t.id, name: t.name, slug: t.slug,
    ownerName: t.ownerName || null,
    ownerEmail: t.ownerEmail || null,
    domain: t.domain, logoUrl: t.logoUrl,
    primaryColor: t.primaryColor, status: t.status,
    ratePerMinute: t.ratePerMinute, totalMinutes: t.totalMinutes,
    hasCalcom:    !!t.calcomApiKey,
    hasHubspot:   !!t.hubspotAccessToken,
    hasGcal:      !!t.googleCalendarToken,
    clonedVoiceId:   t.clonedVoiceId   || null,
    clonedVoiceName: t.clonedVoiceName || null,
    planExpiresAt: t.planExpiresAt ?? null,
    hasSubscription: !!t.stripeSubscriptionId,
    plan: t.plan ? {
      id: t.plan.id,
      name: t.plan.name,
      price: t.plan.price,
      minutesIncluded: t.plan.minutesIncluded,
      features: t.plan.features || [],
    } : null,
    waRequestedPhone: t.waRequestedPhone || null,
    hasWaConfig: !!(waConfig?.phoneNumberId),
  })
})

// PATCH /api/tenant/profile — update company name, owner name, brand colour, WA request
router.patch('/profile', requireTenantOwner, async (req, res, next) => {
  try {
    const allowed = ['name', 'ownerName', 'primaryColor', 'waRequestedPhone']
    const data = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) data[k] = req.body[k] })
    // Allow explicit null/empty string to clear the WA phone
    if (req.body.waRequestedPhone === '') data.waRequestedPhone = null
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No valid fields provided' })
    const tenant = await prisma.tenant.update({ where: { id: req.tenant.id }, data })
    res.json({
      name: tenant.name,
      ownerName: tenant.ownerName,
      primaryColor: tenant.primaryColor,
      waRequestedPhone: tenant.waRequestedPhone || null,
    })
  } catch (err) { next(err) }
})

// POST /api/tenant/logo — upload/replace company logo
router.post('/logo', requireTenantOwner, logoUpload.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const ext      = path.extname(req.file.originalname).toLowerCase() || '.png'
    const filename = `${req.tenant.id}-${Date.now()}${ext}`
    const logoUrl  = await storageService.uploadFile({
      buffer: req.file.buffer, mimetype: req.file.mimetype, filename, folder: 'logos'
    })
    await prisma.tenant.update({ where: { id: req.tenant.id }, data: { logoUrl } })
    res.json({ logoUrl })
  } catch (err) { next(err) }
})

// PATCH /api/tenant/password — change account password
router.patch('/password', requireTenantOwner, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'currentPassword and newPassword required' })
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' })

    const user = await prisma.tenantUser.findFirst({
      where: { tenantId: req.tenant.id, email: req.tenant.ownerEmail }
    })
    if (!user) return res.status(404).json({ error: 'User not found' })

    const valid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' })

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await prisma.tenantUser.update({ where: { id: user.id }, data: { passwordHash } })
    res.json({ message: 'Password updated' })
  } catch (err) { next(err) }
})

// POST /api/tenant/voice — upload audio, clone on ElevenLabs, save voice ID
router.post('/voice', requireTenantOwner, voiceUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Audio file required' })
    const name = (req.body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Voice name required' })

    // Delete old voice on ElevenLabs if one already exists
    const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant.id } })
    if (tenant?.clonedVoiceId) {
      await axios.delete(`https://api.elevenlabs.io/v1/voices/${tenant.clonedVoiceId}`, {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
      }).catch(() => {}) // ignore if already gone
    }

    // Upload to ElevenLabs instant voice cloning
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype })
    const fd = new FormData()
    fd.append('name', name)
    fd.append('description', `Voice for ${req.tenant.name}`)
    fd.append('files', blob, req.file.originalname || 'voice.mp3')

    const elResp = await axios.post('https://api.elevenlabs.io/v1/voices/add', fd, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      timeout: 120_000
    })

    const voiceId = elResp.data.voice_id
    await prisma.tenant.update({
      where: { id: req.tenant.id },
      data: { clonedVoiceId: voiceId, clonedVoiceName: name }
    })

    res.json({ voiceId, voiceName: name })
  } catch (err) {
    if (err.response?.data) {
      return res.status(422).json({ error: err.response.data.detail?.message || 'ElevenLabs cloning failed' })
    }
    next(err)
  }
})

// DELETE /api/tenant/voice — remove cloned voice
router.delete('/voice', requireTenantOwner, async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.tenant.id } })
    if (tenant?.clonedVoiceId) {
      await axios.delete(`https://api.elevenlabs.io/v1/voices/${tenant.clonedVoiceId}`, {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
      }).catch(() => {})
    }
    await prisma.tenant.update({
      where: { id: req.tenant.id },
      data: { clonedVoiceId: null, clonedVoiceName: null }
    })
    res.json({ message: 'Voice removed' })
  } catch (err) { next(err) }
})

// POST /api/tenant/plan — only for free plans; paid plans go through /api/stripe/checkout
router.post('/plan', requireTenantOwner, async (req, res, next) => {
  try {
    const { planId } = req.body
    if (!planId) return res.status(400).json({ error: 'planId required' })

    const plan = await prisma.plan.findUnique({ where: { id: planId } })
    if (!plan || !plan.isActive) return res.status(404).json({ error: 'Plan not found or inactive' })
    if (plan.price > 0) return res.status(400).json({ error: 'Paid plans require Stripe checkout' })

    await prisma.tenant.update({
      where: { id: req.tenant.id },
      data: { planId, ratePerMinute: plan.price }
    })

    res.json({ plan: { id: plan.id, name: plan.name, price: plan.price, minutesIncluded: plan.minutesIncluded } })
  } catch (err) { next(err) }
})

router.patch('/integrations', requireTenantOwner, async (req, res, next) => {
  try {
    const allowed = ['calcomApiKey','calcomEventTypeId','hubspotAccessToken','googleCalendarToken']
    const data = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) data[k] = req.body[k] })
    await prisma.tenant.update({ where: { id: req.tenant.id }, data })
    res.json({ message: 'Integrations updated' })
  } catch (err) { next(err) }
})

module.exports = router
