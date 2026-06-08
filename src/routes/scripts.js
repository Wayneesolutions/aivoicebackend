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
