// One-time script: resets bogus durations on NO_ANSWER calls
// Run from backend folder: node fix-durations.js

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  // Reset NO_ANSWER calls with duration > 10 minutes (these were stuck, not real calls)
  const fixed = await prisma.call.updateMany({
    where: {
      outcome: 'NO_ANSWER',
      durationSeconds: { gt: 600 }
    },
    data: { durationSeconds: 0 }
  })

  // Also fix any still-stuck calls (IN_PROGRESS / RINGING older than 30min)
  const cutoff = new Date(Date.now() - 30 * 60 * 1000)
  const stale = await prisma.call.findMany({
    where: { status: { in: ['IN_PROGRESS', 'RINGING', 'INITIATED'] }, createdAt: { lt: cutoff } }
  })
  for (const call of stale) {
    await prisma.call.update({
      where: { id: call.id },
      data: { status: 'COMPLETED', outcome: 'NO_ANSWER', durationSeconds: 0, endedAt: new Date() }
    })
    await prisma.lead.update({
      where: { id: call.leadId },
      data: { status: 'NO_ANSWER' }
    })
  }

  console.log(`Done — bogus durations reset: ${fixed.count}, stuck calls cleaned: ${stale.length}`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
