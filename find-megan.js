// Quick lookup — find Megan's call and see what outcome/transcript was stored
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function main() {
  const leads = await p.lead.findMany({
    where: { name: { contains: 'megan', mode: 'insensitive' } },
    include: {
      calls: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, vapiCallId: true, outcome: true, status: true, createdAt: true, transcript: true, summary: true }
      }
    }
  })

  if (!leads.length) {
    console.log('No lead named Megan found in the database.')
    return
  }

  for (const lead of leads) {
    console.log(`\nLead: ${lead.name} | ${lead.phone} | status: ${lead.status} | isOptedOut: ${lead.isOptedOut}`)
    for (const call of lead.calls) {
      console.log(`  Call: ${call.createdAt.toISOString().slice(0,10)} | outcome: ${call.outcome} | status: ${call.status}`)
      console.log(`  Summary: ${call.summary || '(none)'}`)
      console.log(`  Transcript: ${(call.transcript || '(none)').slice(0, 400)}`)
    }
  }
}

main().catch(console.error).finally(() => p.$disconnect())
