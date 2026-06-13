require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function main() {
  // Show current state
  const leads = await p.lead.findMany({
    select: { id: true, name: true, status: true, callAttempts: true, isOptedOut: true }
  })
  console.log('Before reset:')
  console.table(leads)

  // Force reset ALL leads including BOOKED — useful for testing
  const result = await p.lead.updateMany({
    where: {},
    data: { status: 'PENDING', callAttempts: 0, lastCalledAt: null, isOptedOut: false }
  })
  console.log(`\nReset ${result.count} lead(s) → PENDING`)
  await p.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
