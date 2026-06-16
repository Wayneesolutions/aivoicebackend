// backend/src/routes/tenant.js
const router = require('express').Router()
const multer = require('multer')
const axios = require('axios')
const { PrismaClient } = require('@prisma/client')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const { getUsageSummary } = require('../services/billing')
const prisma = new PrismaClient()

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
  res.json({
    id: t.id, name: t.name, slug: t.slug,
    domain: t.domain, logoUrl: t.logoUrl,
    primaryColor: t.primaryColor, status: t.status,
    ratePerMinute: t.ratePerMinute, totalMinutes: t.totalMinutes,
    hasCalcom:    !!t.calcomApiKey,
    hasHubspot:   !!t.hubspotAccessToken,
    hasGcal:      !!t.googleCalendarToken,
    clonedVoiceId:   t.clonedVoiceId   || null,
    clonedVoiceName: t.clonedVoiceName || null,
    plan: t.plan ? {
      id: t.plan.id,
      name: t.plan.name,
      price: t.plan.price,
      minutesIncluded: t.plan.minutesIncluded,
      features: t.plan.features || [],
    } : null,
  })
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
