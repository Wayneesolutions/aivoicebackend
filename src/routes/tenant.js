// backend/src/routes/tenant.js
const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const { getUsageSummary } = require('../services/billing')
const prisma = new PrismaClient()

router.get('/me', requireTenantUser, async (req, res) => {
  const t = req.tenant
  res.json({
    id: t.id, name: t.name, slug: t.slug,
    domain: t.domain, logoUrl: t.logoUrl,
    primaryColor: t.primaryColor, status: t.status,
    ratePerMinute: t.ratePerMinute, totalMinutes: t.totalMinutes,
    hasCalcom:    !!t.calcomApiKey,
    hasHubspot:   !!t.hubspotAccessToken,
    hasGcal:      !!t.googleCalendarToken
  })
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
