// optout-now.js — immediate compliance fix
// Opts out Lead 244 (+19058026956) and Lead 218 (+15194961828)
// Run on production: node optout-now.js
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const PHONES = ['+19058026956', '+15194961828']

async function main() {
  for (const phone of PHONES) {
    const lead = await p.lead.findFirst({ where: { phone } })
    if (!lead) { console.log(`NOT FOUND: ${phone}`); continue }

    await p.lead.update({
      where: { id: lead.id },
      data: { status: 'OPTED_OUT', isOptedOut: true, optedOutAt: new Date() }
    })
    await p.call.updateMany({
      where: { leadId: lead.id, outcome: 'NOT_INTERESTED' },
      data: { outcome: 'OPTED_OUT' }
    })
    console.log(`✓ Opted out: ${lead.name} (${phone})`)
  }
}

main().catch(console.error).finally(() => p.$disconnect())
