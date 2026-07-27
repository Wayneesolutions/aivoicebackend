// One-time script: compute and store costs for all existing calls that have
// a duration but no costTotal yet.
// Run once: node scripts/backfill-costs.js
require('dotenv').config()
const prisma = require('../src/lib/prisma')
const { estimateCallCost } = require('../src/services/callCost')

async function main() {
  const calls = await prisma.call.findMany({
    where: {
      costTotal: null,
      durationSeconds: { not: null, gt: 0 },
    },
    select: {
      id: true,
      durationSeconds: true,
      phoneNumber: { select: { telephonyCostPerMinute: true } },
    },
  })

  console.log(`Found ${calls.length} calls to backfill`)

  let done = 0
  for (const call of calls) {
    const costs = estimateCallCost(call.durationSeconds, call.phoneNumber)
    await prisma.call.update({ where: { id: call.id }, data: costs })
    done++
    if (done % 50 === 0) console.log(`  ${done}/${calls.length}`)
  }

  console.log(`Done — backfilled ${done} calls`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
