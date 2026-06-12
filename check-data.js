require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function run() {
  const calls = await p.call.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { lead: { select: { name: true, status: true } } }
  })
  console.log('\n=== LAST 5 CALLS ===')
  for (const c of calls) {
    console.log(`- ${c.lead?.name} | status=${c.status} | outcome=${c.outcome} | duration=${c.durationSeconds}s | booked=${c.meetingBookedAt} | vapiId=${c.vapiCallId}`)
    if (c.transcript) console.log('  TRANSCRIPT:', c.transcript.slice(0, 200) + '...')
    if (c.summary)    console.log('  SUMMARY:', c.summary)
  }

  const leads = await p.lead.findMany({ orderBy: { updatedAt: 'desc' }, take: 5 })
  console.log('\n=== LAST 5 LEADS ===')
  for (const l of leads) {
    console.log(`- ${l.name} | status=${l.status} | attempts=${l.callAttempts} | booked=${l.meetingBookedAt} | meetingLink=${l.meetingLink}`)
  }

  await p.$disconnect()
}
run().catch(console.error)
