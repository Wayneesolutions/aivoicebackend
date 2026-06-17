// backend/src/services/billing.js
const prisma = require('../lib/prisma')

async function logUsage({ tenantId, callId, minutes, ratePerMinute, amount }) {
  await Promise.all([
    prisma.usageLog.create({ data: { tenantId, callId, minutes, ratePerMinute, amount } }),
    prisma.tenant.update({
      where: { id: tenantId },
      data: { totalMinutes: { increment: minutes } }
    })
  ])
}

async function getUsageSummary(tenantId, startDate, endDate) {
  const [logs, tenant] = await Promise.all([
    prisma.usageLog.findMany({
      where: { tenantId, createdAt: { gte: startDate, lte: endDate } }
    }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { ratePerMinute: true } })
  ])
  const totalMinutes = logs.reduce((s, l) => s + l.minutes, 0)
  const totalAmount  = logs.reduce((s, l) => s + l.amount,  0)
  return {
    ratePerMinute: tenant?.ratePerMinute ?? 0,
    totalMinutes,
    totalAmount,
    count: logs.length,
    period: { from: startDate.toISOString(), to: endDate.toISOString() }
  }
}

module.exports = { logUsage, getUsageSummary }
