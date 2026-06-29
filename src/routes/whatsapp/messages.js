// backend/src/routes/whatsapp/messages.js
// Read-only message log — inbound and outbound, filterable by contact / campaign / direction.

const router = require('express').Router()
const prisma  = require('../../lib/prisma')
const { requireTenantUser } = require('../../middleware/auth')

// GET /api/whatsapp/messages
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const { contactId, campaignId, direction, page = 1, limit = 50 } = req.query
    const take = Math.min(200, parseInt(limit, 10))
    const skip = (Math.max(1, parseInt(page, 10)) - 1) * take

    const where = { tenantId: req.tenant.id }
    if (contactId)  where.contactId  = contactId
    if (campaignId) where.campaignId = campaignId
    if (direction)  where.direction  = direction

    const [messages, total] = await Promise.all([
      prisma.waMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          contact:  { select: { id: true, fullName: true, phone: true } },
          campaign: { select: { id: true, name: true } },
        },
      }),
      prisma.waMessage.count({ where }),
    ])

    res.json({ messages, total, page: parseInt(page, 10), pages: Math.ceil(total / take) })
  } catch (err) { next(err) }
})

module.exports = router
