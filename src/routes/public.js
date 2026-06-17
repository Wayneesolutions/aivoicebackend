// backend/src/routes/public.js
// Unauthenticated public API endpoints (pricing page, contact form, etc.)
const router  = require('express').Router()
const rateLimit = require('express-rate-limit')
const prisma  = require('../lib/prisma')
const { sendContactInquiry } = require('../services/email')

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: 'Too many contact requests — please try again later.',
})
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')

const USE_S3 = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET)
const s3 = USE_S3 ? new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
}) : null

// GET /api/public/logo/:tenantId — proxy tenant logo through backend (bypasses S3 public access)
router.get('/logo/:tenantId', async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.tenantId },
      select: { logoUrl: true }
    })
    if (!tenant?.logoUrl) return res.status(404).end()

    if (USE_S3 && tenant.logoUrl.includes('.amazonaws.com')) {
      const key = tenant.logoUrl.split('.amazonaws.com/')[1]
      const cmd = new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: key })
      const obj = await s3.send(cmd)
      res.setHeader('Content-Type', obj.ContentType || 'image/png')
      res.setHeader('Cache-Control', 'public, max-age=86400')
      obj.Body.pipe(res)
    } else {
      // Local disk URL — redirect directly
      res.redirect(tenant.logoUrl)
    }
  } catch {
    res.status(404).end()
  }
})

// GET /api/public/plans — active plans ordered for display
router.get('/plans', async (req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({
      where:   { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: {
        id: true, name: true, blurb: true, price: true,
        minutesIncluded: true, features: true, isPopular: true,
      }
    })
    res.json(plans)
  } catch (err) { next(err) }
})

// POST /api/public/contact — contact / demo request form
router.post('/contact', contactLimiter, async (req, res, next) => {
  try {
    const { firstName, lastName, email, company, phone, callVolume, message } = req.body

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !company?.trim()) {
      return res.status(400).json({ error: 'firstName, lastName, email and company are required.' })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address.' })
    }

    await sendContactInquiry({ firstName, lastName, email, company, phone, callVolume, message })
    res.json({ message: 'Inquiry received' })
  } catch (err) { next(err) }
})

module.exports = router
