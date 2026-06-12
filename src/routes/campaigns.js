// backend/src/routes/campaigns.js
const router = require('express').Router()
const { PrismaClient } = require('@prisma/client')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const { triggerCampaign } = require('../workers/dialQueue')
const prisma = new PrismaClient()

router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { tenantId: req.tenant.id },
      include: {
        script: { select: { id: true, name: true, status: true, agentName: true } },
        _count: { select: { leads: true, calls: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json(campaigns)
  } catch (err) { next(err) }
})

router.post('/', requireTenantOwner, async (req, res, next) => {
  try {
    const { name, scriptId, callFromHour, callToHour, timezone, callDays, maxAttempts, retryAfterHours, includeAllLeads } = req.body
    if (!name || !scriptId) return res.status(400).json({ error: 'name and scriptId required' })

    const script = await prisma.script.findFirst({ where: { id: scriptId, tenantId: req.tenant.id } })
    if (!script) return res.status(404).json({ error: 'Script not found' })
    if (!['APPROVED', 'LIVE'].includes(script.status))
      return res.status(400).json({ error: 'Script must be approved before creating a campaign' })

    const campaign = await prisma.campaign.create({
      data: {
        tenantId: req.tenant.id, scriptId, name,
        callFromHour: callFromHour || 9, callToHour: callToHour || 17,
        timezone: timezone || 'America/New_York',
        callDays: callDays || 'MON,TUE,WED,THU,FRI',
        maxAttempts: maxAttempts || 3, retryAfterHours: retryAfterHours || 24
      }
    })

    // Assign all unassigned PENDING leads to this campaign
    if (includeAllLeads) {
      await prisma.lead.updateMany({
        where: { tenantId: req.tenant.id, campaignId: null, status: 'PENDING', isOptedOut: false },
        data: { campaignId: campaign.id }
      })
    }

    res.status(201).json(campaign)
  } catch (err) { next(err) }
})

router.patch('/:id', requireTenantOwner, async (req, res, next) => {
  try {
    const allowed = ['name', 'callFromHour', 'callToHour', 'timezone', 'callDays', 'maxAttempts', 'retryAfterHours']
    const data = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) data[k] = req.body[k] })
    const campaign = await prisma.campaign.update({
      where: { id: req.params.id, tenantId: req.tenant.id },
      data
    })
    res.json(campaign)
  } catch (err) { next(err) }
})

router.post('/:id/start', requireTenantOwner, async (req, res, next) => {
  try {
    await prisma.campaign.update({
      where: { id: req.params.id, tenantId: req.tenant.id },
      data: { status: 'ACTIVE', startedAt: new Date() }
    })
    await triggerCampaign(req.params.id)
    res.json({ message: 'Campaign started' })
  } catch (err) { next(err) }
})

router.post('/:id/pause', requireTenantOwner, async (req, res, next) => {
  try {
    await prisma.campaign.update({
      where: { id: req.params.id, tenantId: req.tenant.id },
      data: { status: 'PAUSED', pausedAt: new Date() }
    })
    res.json({ message: 'Campaign paused' })
  } catch (err) { next(err) }
})

module.exports = router
