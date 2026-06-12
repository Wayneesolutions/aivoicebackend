// backend/src/routes/billing.js
const router = require('express').Router()
const { requireTenantUser } = require('../middleware/auth')
const { getUsageSummary } = require('../services/billing')
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

router.get('/summary', requireTenantUser, async (req, res, next) => {
  try {
    const { from, to } = req.query
    const start = from ? new Date(from) : new Date(new Date().setDate(1))
    const end   = to   ? new Date(to)   : new Date()
    const summary = await getUsageSummary(req.tenant.id, start, end)
    res.json(summary)
  } catch (err) { next(err) }
})

router.get('/history', requireTenantUser, async (req, res, next) => {
  try {
    const logs = await prisma.usageLog.findMany({
      where: { tenantId: req.tenant.id },
      orderBy: { createdAt: 'desc' },
      take: 100
    })
    res.json(logs.map(l => ({ ...l, rate: l.ratePerMinute })))
  } catch (err) { next(err) }
})

module.exports = router
