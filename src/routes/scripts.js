// backend/src/routes/scripts.js
const router = require('express').Router()
const multer = require('multer')
const pdfParse = require('pdf-parse')
const axios = require('axios')
const prisma = require('../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// GET /api/scripts/voices — ElevenLabs voice list (cloned first, then premade)
router.get('/voices', requireTenantUser, async (req, res, next) => {
  try {
    const resp = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
    })
    const tenantClonedVoiceId = req.tenant.clonedVoiceId
    const categoryOrder = { cloned: 0, generated: 1, premade: 2 }
    const voices = resp.data.voices
      .filter(v => v.category !== 'cloned' || v.voice_id === tenantClonedVoiceId)
      .map(v => ({
        id: v.voice_id,
        name: v.name,
        category: v.category,
        gender: v.labels?.gender || null,
        accent: v.labels?.accent || null,
        language: v.labels?.language || null,
        description: v.labels?.description || null,
        previewUrl: v.preview_url || null,
      }))
      .sort((a, b) => (categoryOrder[a.category] ?? 3) - (categoryOrder[b.category] ?? 3))
    res.json(voices)
  } catch (err) { next(err) }
})

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
    const { name, companyInfo, servicesInfo, goalText, objections, agentName, voiceId, language, agentGender } = req.body
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
        language:    language   || 'en',
        agentGender: agentGender === 'male' ? 'male' : 'female',
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
