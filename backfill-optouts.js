// backfill-optouts.js
// Scans all NOT_INTERESTED calls for opt-out language in transcript/summary
// and upgrades them to OPTED_OUT retroactively.
// Run: node backfill-optouts.js
// Dry run (no writes): node backfill-optouts.js --dry-run
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const DRY_RUN = process.argv.includes('--dry-run')

const OPT_OUT_PHRASES = [
  'remove me from your call list',
  'remove me from the call list',
  'remove me from your calling list',
  'take me off the calling list',
  'take me off your calling list',
  'take me off your call list',
  'take me off your list',
  'take me off the list',
  'remove me from your list',
  'please remove me',
  'stop calling me',
  'do not call me again',
  "don't call me again",
  'add me to your do not call',
  'put me on your do not call',
  'opt me out',
]

const SOFT_OPT_OUT_PHRASES = [
  "please don't call us anymore",
  "please don't call us again",
  "please don't call again",
  "please don't call back",
  "don't call us again",
  "don't call us back",
  "don't call us anymore",
  "never call us again",
  "never call me again",
  "please don't contact us",
  "don't contact us again",
  "do not contact us again",
  "do not contact us",
  "we don't want to be contacted",
  "we do not want to be contacted",
  "please stop calling",
  "please stop contacting",
  "not interested now or ever",
  "not interested, ever",
  "we will never need your services",
  "we'll never need your services",
  "will never need your services",
  "we never want to hear from you",
  "we don't want any more calls",
  "we don't want any calls from you",
  "we don't want to receive calls",

  // Service rejection
  "we don't need any services",
  "we don't need your services",
  "don't need any services",
  "don't need your services",
  "no need for your services",
  "not interested in any services",
  "we have no need for your services",
  "we don't require any services",
]

function detectOptOut(transcript, summary) {
  const text = ((transcript || '') + ' ' + (summary || '')).toLowerCase()
  const tier1 = OPT_OUT_PHRASES.find(phrase => text.includes(phrase))
  if (tier1) return tier1
  const tier2 = SOFT_OPT_OUT_PHRASES.find(phrase => text.includes(phrase))
  if (tier2) return tier2
  return null
}

async function main() {
  console.log(`\n[backfill-optouts] mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`)

  // Fetch all NOT_INTERESTED calls that have a transcript or summary
  const calls = await p.call.findMany({
    where: {
      outcome: 'NOT_INTERESTED',
      OR: [
        { transcript: { not: null } },
        { summary:    { not: null } },
      ]
    },
    select: {
      id:         true,
      leadId:     true,
      transcript: true,
      summary:    true,
      lead:       { select: { name: true, phone: true } }
    }
  })

  console.log(`[backfill-optouts] Found ${calls.length} NOT_INTERESTED calls with transcript/summary`)

  let upgraded = 0
  let skipped  = 0

  for (const call of calls) {
    const matched = detectOptOut(call.transcript, call.summary)
    if (!matched) { skipped++; continue }

    console.log(`  → upgrading call ${call.id} | lead: ${call.lead?.name} (${call.lead?.phone}) | phrase: "${matched}"`)

    if (!DRY_RUN) {
      await p.call.update({
        where: { id: call.id },
        data:  { outcome: 'OPTED_OUT' }
      })
      await p.lead.update({
        where: { id: call.leadId },
        data:  { status: 'OPTED_OUT', isOptedOut: true, optedOutAt: new Date() }
      })
    }

    upgraded++
  }

  console.log(`\n[backfill-optouts] Done.`)
  console.log(`  Upgraded : ${upgraded}`)
  console.log(`  Skipped  : ${skipped} (no opt-out language found)`)
  if (DRY_RUN) console.log(`  (dry run — nothing was written)`)
}

main().catch(console.error).finally(() => p.$disconnect())
