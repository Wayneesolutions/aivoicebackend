// Inbound analytics — call metrics and trends
const router = require('express').Router();
const prisma  = require('../lib/prisma');
const { requireTenantUser } = require('../middleware/auth');

// GET /api/inbound/analytics?days=30
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const days  = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where = { tenantId: req.tenant.id, createdAt: { gte: since } };

    const [total, byOutcome, allCalls, liveCalls] = await Promise.all([
      prisma.inboundCall.count({ where }),

      prisma.inboundCall.groupBy({
        by: ['outcome'],
        where,
        _count: { _all: true },
      }),

      prisma.inboundCall.findMany({
        where,
        select: { createdAt: true, startedAt: true, durationSeconds: true, outcome: true },
        orderBy: { createdAt: 'asc' },
      }),

      prisma.inboundCall.count({ where: { tenantId: req.tenant.id, endedAt: null } }),
    ]);

    const outcomeMap = Object.fromEntries(
      byOutcome.filter(o => o.outcome).map(o => [o.outcome, o._count._all])
    );

    const totalWithDuration = allCalls.filter(c => c.durationSeconds);
    const avgDuration = totalWithDuration.length
      ? Math.round(totalWithDuration.reduce((s, c) => s + c.durationSeconds, 0) / totalWithDuration.length)
      : 0;

    const transferRate = total > 0
      ? Math.round(((outcomeMap['TRANSFERRED'] || 0) / total) * 1000) / 10
      : 0;

    // Calls per day
    const dayMap = {};
    for (let d = new Date(since); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      dayMap[key] = { date: key, count: 0 };
    }
    for (const c of allCalls) {
      const key = (c.createdAt || c.startedAt || new Date()).toISOString().slice(0, 10);
      if (dayMap[key]) dayMap[key].count++;
    }
    const daily = Object.values(dayMap).map(d => ({
      date:  new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      count: d.count,
    }));

    // Calls by hour of day
    const hourMap = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
    for (const c of allCalls) {
      const h = (c.startedAt || c.createdAt || new Date()).getHours();
      hourMap[h].count++;
    }

    res.json({
      summary: {
        totalCalls:   total,
        avgDuration,
        transferRate,
        liveNow:      liveCalls,
        transferred:  outcomeMap['TRANSFERRED'] || 0,
        completed:    outcomeMap['COMPLETED']   || 0,
        voicemail:    outcomeMap['VOICEMAIL']   || 0,
        noAnswer:     outcomeMap['NO_ANSWER']   || 0,
        failed:       outcomeMap['FAILED']      || 0,
      },
      byOutcome: Object.entries(outcomeMap).map(([outcome, count]) => ({ outcome, count })),
      daily,
      byHour: hourMap,
    });
  } catch (err) { next(err); }
});

module.exports = router;
