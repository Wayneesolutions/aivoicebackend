// backend/src/routes/campaigns.js
const router = require('express').Router()
const prisma = require('../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const { triggerCampaign, drainCampaignJobs } = require('../workers/dialQueue')

router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const [campaigns, outcomeRows] = await Promise.all([
      prisma.campaign.findMany({
        where: { tenantId: req.tenant.id },
        include: {
          script: { select: { id: true, name: true, status: true, agentName: true } },
          _count: { select: { leads: true, calls: true } }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.call.groupBy({
        by: ['campaignId', 'outcome'],
        where: { tenantId: req.tenant.id, campaignId: { not: null }, status: 'COMPLETED', outcome: { not: null } },
        _count: { id: true }
      })
    ])

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
    const { name, scriptId, callFromHour, callToHour, timezone, callDays, maxAttempts, retryAfterHours, includeAllLeads, leadIds, batchId, batchLimit } = req.body
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

    if (batchId) {
      // Assign PENDING unassigned leads from the specified batch (up to batchLimit if given)
      const batchWhere = {
        tenantId:      req.tenant.id,
        uploadBatchId: batchId,
        campaignId:    null,
        status:        'PENDING',
        isOptedOut:    false
      }
      const limit = batchLimit ? parseInt(batchLimit) : undefined
      if (limit && limit > 0) {
        // Need to find specific IDs first so we can respect the limit
        const leads = await prisma.lead.findMany({
          where:   batchWhere,
          select:  { id: true },
          take:    limit,
          orderBy: { createdAt: 'asc' }
        })
        if (leads.length > 0) {
          await prisma.lead.updateMany({
            where: { id: { in: leads.map(l => l.id) } },
            data:  { campaignId: campaign.id }
          })
        }
      } else {
        await prisma.lead.updateMany({
          where: batchWhere,
          data:  { campaignId: campaign.id }
        })
      }
    } else if (Array.isArray(leadIds) && leadIds.length > 0) {
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

    if (req.body.scriptId !== undefined) {
      const script = await prisma.script.findFirst({ where: { id: req.body.scriptId, tenantId: req.tenant.id } })
      if (!script) return res.status(404).json({ error: 'Script not found' })
      if (!['APPROVED', 'LIVE'].includes(script.status))
        return res.status(400).json({ error: 'Script must be approved before linking to a campaign' })
      data.scriptId = req.body.scriptId
    }

    const campaign = await prisma.campaign.update({
      where: { id: req.params.id, tenantId: req.tenant.id },
      data
    })
    res.json(campaign)
  } catch (err) { next(err) }
})

router.post('/:id/start', requireTenantOwner, async (req, res, next) => {
  try {
    const hasNumber = await prisma.tenantPhone.findFirst({
      where: { tenantId: req.tenant.id, isActive: true, vapiNumberId: { not: null } }
    })
    if (!hasNumber) {
      return res.status(400).json({ error: 'No phone number configured for your account. Please contact your admin to set one up before starting a campaign.' })
    }

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
    await drainCampaignJobs(req.params.id)
    // Reset any leads stuck in CALLING (their BullMQ jobs were just drained above).
    // Without this, those leads stay CALLING forever — never re-queued on resume.
    await prisma.lead.updateMany({
      where: { campaignId: req.params.id, status: 'CALLING' },
      data: { status: 'PENDING' }
    })
    res.json({ message: 'Campaign paused' })
  } catch (err) { next(err) }
})

// GET /api/campaigns/:id/callbacks
// Returns all CALLBACK leads for this campaign
router.get('/:id/callbacks', requireTenantUser, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      select: { id: true }
    })
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

    const leads = await prisma.lead.findMany({
      where: { campaignId: campaign.id, status: 'CALLBACK' },
      orderBy: { lastCalledAt: 'desc' },
      select: { id: true, name: true, phone: true, company: true, callAttempts: true, lastCalledAt: true }
    })

    res.json({ leads, total: leads.length })
  } catch (err) { next(err) }
})

// GET /api/campaigns/:id/no-answers
// Returns all NO_ANSWER leads for this campaign with retry eligibility
router.get('/:id/no-answers', requireTenantUser, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      select: { id: true, maxAttempts: true }
    })
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

    const leads = await prisma.lead.findMany({
      where: {
        campaignId: campaign.id,
        status: { in: ['NO_ANSWER', 'EXHAUSTED'] }   // ← was just 'NO_ANSWER'
      },
      orderBy: { lastCalledAt: 'desc' },
      select: {
        id: true, name: true, phone: true, company: true,
        callAttempts: true, lastCalledAt: true, status: true   // ← add status, see below
      }
    })

    const retryableCount = leads.filter(l => l.callAttempts < campaign.maxAttempts).length
    const exhaustedCount = leads.length - retryableCount

    res.json({
      leads,
      maxAttempts:    campaign.maxAttempts,
      retryableCount,
      exhaustedCount,
      total:          leads.length
    })
  } catch (err) { next(err) }
})

// POST /api/campaigns/:id/retry-no-answers
// Resets NO_ANSWER leads back to PENDING and triggers the dialer immediately
// body: { includeExhausted: boolean }
router.post('/:id/retry-no-answers', requireTenantOwner, async (req, res, next) => {
  try {
    const { includeExhausted = false } = req.body

    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      select: { id: true, maxAttempts: true, status: true }
    })
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

    // Always reset leads that still have attempts left
    const retryableResult = await prisma.lead.updateMany({
      where: {
        campaignId:   campaign.id,
        status:       'NO_ANSWER',
        callAttempts: { lt: campaign.maxAttempts }
      },
      data: { status: 'PENDING', lastCalledAt: null }
    })

    let exhaustedReset = 0
    if (includeExhausted) {
      // Also reset exhausted leads — zero out attempt counter so they get fresh tries
      const exhaustedResult = await prisma.lead.updateMany({
        where: {
          campaignId:   campaign.id,
          status:       { in: ['NO_ANSWER', 'EXHAUSTED'] },
          callAttempts: { gte: campaign.maxAttempts }
        },
        data: { status: 'PENDING', callAttempts: 0, lastCalledAt: null }
      })
      exhaustedReset = exhaustedResult.count
    }

    const totalReset = retryableResult.count + exhaustedReset

    let queued = false
    let finalStatus = campaign.status

    if (totalReset > 0) {
      if (campaign.status === 'ACTIVE') {
        await triggerCampaign(campaign.id)
        queued = true
      } else if (campaign.status === 'COMPLETED') {
        // Re-activate so the dialer can pick up the reset leads
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: 'ACTIVE', startedAt: new Date() }
        })
        await triggerCampaign(campaign.id)
        queued = true
        finalStatus = 'ACTIVE'
      }
    }

    res.json({ reset: totalReset, queued, campaignStatus: finalStatus })
  } catch (err) { next(err) }
})

// POST /api/campaigns/:id/retry-outcome
// Resets VOICEMAIL or CALLBACK leads back to PENDING and triggers the dialer
router.post('/:id/retry-outcome', requireTenantOwner, async (req, res, next) => {
  try {
    const { outcome } = req.body
    if (!['VOICEMAIL', 'CALLBACK'].includes(outcome))
      return res.status(400).json({ error: 'outcome must be VOICEMAIL or CALLBACK' })

    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      select: { id: true, status: true }
    })
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

    const result = await prisma.lead.updateMany({
      where: { campaignId: campaign.id, status: outcome },
      data: { status: 'PENDING', lastCalledAt: null }
    })

    let queued = false
    let finalStatus = campaign.status

    if (result.count > 0) {
      if (campaign.status === 'ACTIVE') {
        await triggerCampaign(campaign.id)
        queued = true
      } else if (['COMPLETED', 'PAUSED'].includes(campaign.status)) {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: 'ACTIVE', startedAt: new Date() }
        })
        await triggerCampaign(campaign.id)
        queued = true
        finalStatus = 'ACTIVE'
      }
    }

    res.json({ reset: result.count, queued, campaignStatus: finalStatus })
  } catch (err) { next(err) }
})

module.exports = router
