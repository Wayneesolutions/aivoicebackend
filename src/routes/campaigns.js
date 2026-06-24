// backend/src/routes/campaigns.js
const router = require('express').Router()
const prisma = require('../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const { triggerCampaign } = require('../workers/dialQueue')

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

    const ids = campaigns.map(c => c.id)
    const outcomeRows = await prisma.call.groupBy({
      by: ['campaignId', 'outcome'],
      where: { campaignId: { in: ids }, status: 'COMPLETED', outcome: { not: null } },
      _count: { id: true }
    })

    const outcomeMap = {}
    outcomeRows.forEach(row => {
      if (!outcomeMap[row.campaignId]) outcomeMap[row.campaignId] = {}
      outcomeMap[row.campaignId][row.outcome] = row._count.id
    })

    res.json(campaigns.map(c => ({ ...c, outcomeCounts: outcomeMap[c.id] || {} })))
  } catch (err) { next(err) }
})

router.post('/', requireTenantOwner, async (req, res, next) => {
  try {
    const { name, scriptId, callFromHour, callToHour, timezone, callDays, maxAttempts, retryAfterHours, includeAllLeads, leadIds } = req.body
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

    if (Array.isArray(leadIds) && leadIds.length > 0) {
      // Assign only the selected leads (must belong to this tenant and be unassigned)
      await prisma.lead.updateMany({
        where: { id: { in: leadIds }, tenantId: req.tenant.id, campaignId: null, isOptedOut: false },
        data: { campaignId: campaign.id }
      })
    } else if (includeAllLeads) {
      // Assign all unassigned PENDING leads
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
