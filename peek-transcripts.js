// Temporary diagnostic — peek at NO_ANSWER transcripts to see actual wording
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function main() {
  const calls = await p.call.findMany({
    where: {
      outcome: 'NO_ANSWER',
      transcript: { not: null }
    },
    select: {
      id: true, vapiCallId: true, createdAt: true,
      transcript: true, summary: true,
      lead: { select: { name: true, phone: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: 10
  })

  for (const c of calls) {
    console.log(`\n--- ${c.lead?.name} (${c.lead?.phone}) | ${c.createdAt.toISOString().slice(0,10)} ---`)
    console.log('SUMMARY:', c.summary || '(none)')
    const preview = (c.transcript || '').slice(0, 600)
    console.log('TRANSCRIPT (first 600 chars):\n', preview)
  }
}

main().catch(console.error).finally(() => p.$disconnect())
