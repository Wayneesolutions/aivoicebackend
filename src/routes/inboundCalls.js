// Inbound call log
const router = require('express').Router();
const prisma  = require('../lib/prisma');
const { requireTenantUser } = require('../middleware/auth');

// GET /api/inbound/calls
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const { limit = 50, offset = 0, outcome, assistantId } = req.query;
    const where = { tenantId: req.tenant.id };
    if (outcome)     where.outcome     = outcome;
    if (assistantId) where.assistantId = assistantId;

    const [calls, total] = await Promise.all([
      prisma.inboundCall.findMany({
        where,
        include: { assistant: { select: { agentName: true, businessName: true } } },
        orderBy: { createdAt: 'desc' },
        skip:  parseInt(offset),
        take:  parseInt(limit),
      }),
      prisma.inboundCall.count({ where }),
    ]);
    res.json({ calls, total });
  } catch (err) { next(err); }
});

// GET /api/inbound/calls/live — active calls (no endedAt)
router.get('/live', requireTenantUser, async (req, res, next) => {
  try {
    const calls = await prisma.inboundCall.findMany({
      where: { tenantId: req.tenant.id, endedAt: null },
      include: { assistant: { select: { agentName: true, businessName: true } } },
      orderBy: { startedAt: 'desc' },
    });
    res.json({ calls, total: calls.length });
  } catch (err) { next(err); }
});

// GET /api/inbound/calls/:id
router.get('/:id', requireTenantUser, async (req, res, next) => {
  try {
    const call = await prisma.inboundCall.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      include: {
        assistant:   { select: { agentName: true, businessName: true } },
        phoneNumber: { select: { phoneNumber: true, country: true } },
      },
    });
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json(call);
  } catch (err) { next(err); }
});

module.exports = router;
