// backend/src/routes/public.js
// Unauthenticated public API endpoints (pricing page, etc.)
const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
const prisma = new PrismaClient()

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

module.exports = router
