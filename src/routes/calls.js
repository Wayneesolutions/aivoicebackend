// backend/src/routes/calls.js
const router = require('express').Router()
const prisma = require('../lib/prisma')
const { requireTenantUser } = require('../middleware/auth')
const axios = require('axios')

const vapiClient = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }
})

router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const { outcome, campaignId, page = 1, limit = 50 } = req.query
    const where = { tenantId: req.tenant.id }
    if (outcome)    where.outcome    = outcome
    if (campaignId) where.campaignId = campaignId

    const [calls, total] = await Promise.all([
      prisma.call.findMany({
        where,
        include: { lead: { select: { name: true, company: true, phone: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit)
      }),
      prisma.call.count({ where })
    ])
    res.json({ calls: calls.map(mapCall), total })
  } catch (err) { next(err) }
})

router.get('/stats', requireTenantUser, async (req, res, next) => {
  try {
    const { from, to } = req.query
    const where = { tenantId: req.tenant.id }

    // Default: last 7 days for stats
    const statsFrom = from ? new Date(from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const statsTo   = to   ? new Date(to)   : new Date()
    where.createdAt = { gte: statsFrom, lte: statsTo }

    const [total, byOutcome, minutesData, allCalls] = await Promise.all([
      prisma.call.count({ where }),
      prisma.call.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
      prisma.call.aggregate({ where, _sum: { billedMinutes: true, billedAmount: true } }),
      // Fetch minimal data for daily breakdown
      prisma.call.findMany({
        where,
        select: { createdAt: true, outcome: true },
        orderBy: { createdAt: 'asc' }
      })
    ])

    const outcomeMap = Object.fromEntries(
      byOutcome.filter(o => o.outcome).map(o => [o.outcome, o._count._all])
    )

    // Build daily breakdown for bar chart
    const dayMap = {}
    for (let d = new Date(statsFrom); d <= statsTo; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10)
      dayMap[key] = { date: key, calls: 0, booked: 0 }
    }
    for (const c of allCalls) {
      const key = c.createdAt.toISOString().slice(0, 10)
      if (dayMap[key]) {
        dayMap[key].calls++
        if (c.outcome === 'BOOKED') dayMap[key].booked++
      }
    }
    const callsByDay = Object.values(dayMap).map(d => ({
      ...d,
      date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }))

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
        : 0,
      callsByDay
    })
  } catch (err) { next(err) }
})

// Proxy recording: fetch fresh presigned URL from Vapi API and redirect
router.get('/:id/recording', requireTenantUser, async (req, res, next) => {
  try {
    const call = await prisma.call.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      select: { vapiCallId: true, recordingUrl: true }
    })
    if (!call) return res.status(404).json({ error: 'Call not found' })

    // Try to get a fresh URL from Vapi if we have the Vapi call ID
    if (call.vapiCallId) {
      try {
        const { data } = await vapiClient.get(`/call/${call.vapiCallId}`)
        const freshUrl = data?.artifact?.recordingUrl || data?.recordingUrl
        if (freshUrl) return res.redirect(302, freshUrl)
      } catch (vapiErr) {
        console.warn('[recording proxy] Vapi fetch failed, falling back to stored URL:', vapiErr.message)
      }
    }

    // Fallback to stored URL
    if (call.recordingUrl) return res.redirect(302, call.recordingUrl)
    res.status(404).json({ error: 'Recording not available' })
  } catch (err) { next(err) }
})

router.get('/:id', requireTenantUser, async (req, res, next) => {
  try {
    const call = await prisma.call.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      include: { lead: true, phoneNumber: true }
    })
    if (!call) return res.status(404).json({ error: 'Call not found' })
    res.json(mapCall(call))
  } catch (err) { next(err) }
})

// Map DB field names → frontend-expected names
function mapCall(c) {
  return {
    ...c,
    duration:    c.durationSeconds,
    meetingAt:   c.meetingBookedAt,
    scheduledAt: c.scheduledMeetingAt   // actual scheduled meeting time
  }
}

module.exports = router
