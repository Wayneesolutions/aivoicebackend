// backend/src/services/billing.js
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

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
  const logs = await prisma.usageLog.findMany({
    where: { tenantId, createdAt: { gte: startDate, lte: endDate } }
  })
  const totalMinutes = logs.reduce((s, l) => s + l.minutes, 0)
  const totalAmount  = logs.reduce((s, l) => s + l.amount,  0)
  return { totalMinutes, totalAmount, count: logs.length }
}

module.exports = { logUsage, getUsageSummary }
