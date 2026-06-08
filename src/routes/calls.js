// backend/src/routes/calls.js
const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { requireTenantUser } = require('../middleware/auth')
const prisma = new PrismaClient()

router.get('/', requireTenantUser, async (req, res, next) => {
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
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit)
      }),
      prisma.call.count({ where })
    ])
    res.json({ calls, total })
  } catch (err) { next(err) }
})

router.get('/stats', requireTenantUser, async (req, res, next) => {
  try {
    const { from, to } = req.query
    const where = { tenantId: req.tenant.id }
    if (from || to) {
      where.createdAt = {}
      if (from) where.createdAt.gte = new Date(from)
      if (to)   where.createdAt.lte = new Date(to)
    }

    const [total, byOutcome, minutesData] = await Promise.all([
      prisma.call.count({ where }),
      prisma.call.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
      prisma.call.aggregate({ where, _sum: { billedMinutes: true, billedAmount: true } })
    ])

    const outcomeMap = Object.fromEntries(
      byOutcome.filter(o => o.outcome).map(o => [o.outcome, o._count._all])
    )

    res.json({
      total,
      booked:        outcomeMap['BOOKED']        || 0,
      notInterested: outcomeMap['NOT_INTERESTED'] || 0,
      noAnswer:      outcomeMap['NO_ANSWER']      || 0,
      voicemail:     outcomeMap['VOICEMAIL']      || 0,
      callback:      outcomeMap['CALLBACK']       || 0,
      totalMinutes:  Math.round((minutesData._sum.billedMinutes || 0) * 10) / 10,
      totalBilled:   Math.round((minutesData._sum.billedAmount  || 0) * 100) / 100,
      conversionRate: total > 0
        ? Math.round((outcomeMap['BOOKED'] || 0) / total * 1000) / 10
        : 0
    })
  } catch (err) { next(err) }
})

router.get('/:id', requireTenantUser, async (req, res, next) => {
  try {
    const call = await prisma.call.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      include: { lead: true, phoneNumber: true }
    })
    if (!call) return res.status(404).json({ error: 'Call not found' })
    res.json(call)
  } catch (err) { next(err) }
})

module.exports = router
