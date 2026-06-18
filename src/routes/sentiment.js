// ============================================================
// FIX-06 — NEW FILE: backend/src/routes/sentiment.js
// This is a completely new file. Create it at that path.
//
// ALSO NEEDED in server.js — add this line with the other routes:
//   app.use('/api/sentiment', require('./routes/sentiment'))
//
// WHAT THIS DOES:
//   Exposes GET /api/sentiment/call/:callId
//   Returns the real-time sentiment log for a live call.
//   The admin frontend polls this every 5 seconds to show
//   the live sentiment dashboard while a call is in progress.
// ============================================================

const router  = require('express').Router()
const prisma  = require('../lib/prisma')
const { requireAdmin, requireTenantUser } = require('../middleware/auth')

// GET /api/sentiment/call/:callId
// Returns full sentiment log for a call. Accessible by admin or the call's tenant user.
router.get('/call/:callId', requireTenantUser, async (req, res, next) => {
  try {
    const call = await prisma.call.findUnique({
      where: { id: req.params.callId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        sentimentLog: true,
        durationSeconds: true,
        startedAt: true,
        lead: { select: { id: true, name: true, company: true } }
      }
    })

    if (!call) return res.status(404).json({ error: 'Call not found' })

    // Tenant users can only see their own calls
    if (req.user.role !== 'ADMIN' && call.tenantId !== req.tenant?.id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const log = Array.isArray(call.sentimentLog) ? call.sentimentLog : []

    // Compute summary from the log
    const latestEntry   = log[log.length - 1] || null
    const hotSignals    = log.filter(e => e.intent === 'HOT').length
    const warmSignals   = log.filter(e => e.intent === 'WARM').length
    const negativeCount = log.filter(e => ['NEGATIVE', 'VERY_NEGATIVE'].includes(e.sentiment)).length

    const overallScore = log.length === 0 ? 'UNKNOWN'
      : hotSignals > 0 ? 'HOT'
      : warmSignals >= 2 ? 'WARM'
      : negativeCount > log.length / 2 ? 'COLD'
      : 'NEUTRAL'

    res.json({
      callId:        call.id,
      status:        call.status,
      lead:          call.lead,
      startedAt:     call.startedAt,
      durationSeconds: call.durationSeconds,
      overallScore,
      latestSentiment: latestEntry?.sentiment || null,
      latestIntent:    latestEntry?.intent    || null,
      suggestedAction: latestEntry?.suggested_action || null,
      buyingSignals:   log.filter(e => e.buying_signal).map(e => e.buying_signal),
      log
    })
  } catch (err) { next(err) }
})

// GET /api/sentiment/active — all currently active calls for this tenant with their latest sentiment
router.get('/active', requireTenantUser, async (req, res, next) => {
  try {
    // Only return calls created in the last 30 minutes — anything older is a stale/stuck record
    const cutoff = new Date(Date.now() - 30 * 60 * 1000)

    const activeCalls = await prisma.call.findMany({
      where: {
        tenantId: req.tenant.id,
        status: { in: ['IN_PROGRESS', 'RINGING', 'INITIATED'] },
        createdAt: { gte: cutoff }
      },
      select: {
        id: true,
        status: true,
        sentimentLog: true,
        startedAt: true,
        lead: { select: { id: true, name: true, company: true } },
        campaign: { select: { name: true } }
      },
      orderBy: { startedAt: 'desc' }
    })

    const result = activeCalls.map(call => {
      const log = Array.isArray(call.sentimentLog) ? call.sentimentLog : []
      const latest = log[log.length - 1] || null
      return {
        callId:    call.id,
        status:    call.status,
        startedAt: call.startedAt,
        lead:      call.lead,
        campaign:  call.campaign?.name || null,
        sentiment: latest?.sentiment    || 'UNKNOWN',
        intent:    latest?.intent       || 'UNKNOWN',
        suggestedAction: latest?.suggested_action || null
      }
    })

    res.json({ activeCalls: result, total: result.length })
  } catch (err) { next(err) }
})

module.exports = router
