// backend/src/routes/sentiment.js
// ============================================================
// BUGFIX — sentiment.js
// BUG FIXED:
//   BUG-6: Routes used requireTenantUser which blocked admin JWT with 403.
//           Admin users couldn't see any live call sentiment data.
//   FIXED:  Both routes now use verifyToken (raw JWT check only).
//           Handler checks role: ADMIN → full access, TENANT_USER → own tenant only.
// ============================================================

const router = require('express').Router()
const prisma = require('../lib/prisma')
const { verifyToken } = require('../middleware/auth')

// ── GET /api/sentiment/call/:callId ───────────────────────────────────────────
// Returns full sentiment log for one call.
// Admin: can see any call. Tenant user: own tenant only.
router.get('/call/:callId', verifyToken, async (req, res, next) => {
  try {
    const call = await prisma.call.findUnique({
      where: { id: req.params.callId },
      select: {
        id:              true,
        tenantId:        true,
        status:          true,
        sentimentLog:    true,
        durationSeconds: true,
        startedAt:       true,
        lead: { select: { id: true, name: true, company: true } }
      }
    })

    if (!call) return res.status(404).json({ error: 'Call not found' })

    // FIX: check role AFTER fetching call — admin always allowed
    if (req.user.role === 'ADMIN') {
      // full access — fall through
    } else if (req.user.role === 'TENANT_USER') {
      if (call.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: 'Access denied' })
      }
    } else {
      return res.status(403).json({ error: 'Access denied' })
    }

    const log = Array.isArray(call.sentimentLog) ? call.sentimentLog : []

    const latestEntry   = log[log.length - 1] || null
    const hotSignals    = log.filter(e => e.intent === 'HOT').length
    const warmSignals   = log.filter(e => e.intent === 'WARM').length
    const negativeCount = log.filter(e => ['NEGATIVE', 'VERY_NEGATIVE'].includes(e.sentiment)).length

    const overallScore = log.length === 0 ? 'UNKNOWN'
      : hotSignals > 0          ? 'HOT'
      : warmSignals >= 2        ? 'WARM'
      : negativeCount > log.length / 2 ? 'COLD'
      : 'NEUTRAL'

    res.json({
      callId:          call.id,
      status:          call.status,
      lead:            call.lead,
      startedAt:       call.startedAt,
      durationSeconds: call.durationSeconds,
      overallScore,
      latestSentiment: latestEntry?.sentiment        || null,
      latestIntent:    latestEntry?.intent           || null,
      suggestedAction: latestEntry?.suggested_action || null,
      buyingSignals:   log.filter(e => e.buying_signal).map(e => e.buying_signal),
      log
    })
  } catch (err) { next(err) }
})

// ── GET /api/sentiment/active ─────────────────────────────────────────────────
// All currently active calls with latest sentiment.
// Admin: sees all tenants. Tenant user: own tenant only.
router.get('/active', verifyToken, async (req, res, next) => {
  try {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000) // 15 min — calls older than this without an end webhook are stale

    // FIX: build where clause based on role
    const where = {
      status:    { in: ['IN_PROGRESS', 'RINGING', 'INITIATED'] },
      createdAt: { gte: cutoff }
    }

    if (req.user.role === 'TENANT_USER') {
      where.tenantId = req.user.tenantId
    }
    // ADMIN: no tenantId filter — sees all active calls across all tenants

    const activeCalls = await prisma.call.findMany({
      where,
      select: {
        id:           true,
        status:       true,
        tenantId:     true,
        sentimentLog: true,
        startedAt:    true,
        lead:         { select: { id: true, name: true, company: true } },
        campaign:     { select: { name: true } },
        tenant:       { select: { name: true } }   // admin needs to know which client
      },
      orderBy: { startedAt: 'desc' }
    })

    const result = activeCalls.map(call => {
      const log    = Array.isArray(call.sentimentLog) ? call.sentimentLog : []
      const latest = log[log.length - 1] || null
      return {
        callId:          call.id,
        status:          call.status,
        tenantName:      call.tenant?.name || null,   // visible to admin
        startedAt:       call.startedAt,
        lead:            call.lead,
        campaign:        call.campaign?.name || null,
        sentiment:       latest?.sentiment        || 'UNKNOWN',
        intent:          latest?.intent           || 'UNKNOWN',
        suggestedAction: latest?.suggested_action || null
      }
    })

    res.json({ activeCalls: result, total: result.length })
  } catch (err) { next(err) }
})

module.exports = router
