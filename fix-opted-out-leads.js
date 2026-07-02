// fix-opted-out-leads.js
// Retroactive compliance cleanup — Section 5 of the Diagnostic Brief.
//
// Scans all NO_ANSWER calls for opt-out language in transcript/summary,
// then marks matching leads as OPTED_OUT so they stop getting redialed.
//
// Usage:
//   node fix-opted-out-leads.js           ← dry run, prints matches only
//   node fix-opted-out-leads.js --apply   ← writes changes to the database

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const DRY_RUN = !process.argv.includes('--apply')

const OPT_OUT_PHRASES = [
  'remove me',
  'stop calling',
  "don't call",
  'do not call',
  'take me off',
  'no more calls',
  'remove from your list',
  'remove from list',
  'opt me out',
  'opted out',
]

async function main() {
  console.log('='.repeat(60))
  console.log(DRY_RUN
    ? 'DRY RUN — no changes will be written (pass --apply to commit)'
    : 'APPLYING CHANGES to database')
  console.log('='.repeat(60))

  // Pull all NO_ANSWER calls that have any transcript or summary to scan
  const candidates = await p.call.findMany({
    where: {
      outcome: 'NO_ANSWER',
      OR: [
        { transcript: { not: null } },
        { summary:    { not: null } },
      ]
    },
    select: {
      id:         true,
      leadId:     true,
      vapiCallId: true,
      transcript: true,
      summary:    true,
      createdAt:  true,
      lead: {
        select: { id: true, name: true, phone: true, status: true, isOptedOut: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  })

  console.log(`\nScanning ${candidates.length} NO_ANSWER call(s) with transcripts...\n`)

  // Find calls whose transcript or summary contains an opt-out phrase
  const matches = []
  for (const call of candidates) {
    const text = ((call.transcript || '') + ' ' + (call.summary || '')).toLowerCase()
    const phrase = OPT_OUT_PHRASES.find(p => text.includes(p))
    if (phrase) matches.push({ ...call, matchedPhrase: phrase })
  }

  if (matches.length === 0) {
    console.log('No opt-out language found in any NO_ANSWER call. Nothing to do.')
    return
  }

  // Deduplicate by leadId — one lead may have multiple matching calls
  const byLead = {}
  for (const m of matches) {
    if (!byLead[m.leadId] || m.createdAt > byLead[m.leadId].createdAt) {
      byLead[m.leadId] = m
    }
  }
  const uniqueLeads = Object.values(byLead)

  console.log(`Found ${matches.length} matching call(s) across ${uniqueLeads.length} unique lead(s):\n`)

  for (const m of uniqueLeads) {
    const alreadyOptedOut = m.lead.isOptedOut
    console.log(`  Lead : ${m.lead.name} (${m.lead.phone})`)
    console.log(`  Call : ${m.vapiCallId || m.id}  |  date: ${m.createdAt.toISOString().slice(0, 10)}`)
    console.log(`  Match: "${m.matchedPhrase}"`)
    console.log(`  Now  : status=${m.lead.status}, isOptedOut=${alreadyOptedOut}`)
    if (alreadyOptedOut) {
      console.log(`  Skip : already opted out — no change needed`)
    } else {
      console.log(`  Will : status=OPTED_OUT, isOptedOut=true, all matching calls → outcome=OPTED_OUT`)
    }
    console.log()
  }

  if (DRY_RUN) {
    const toUpdate = uniqueLeads.filter(m => !m.lead.isOptedOut)
    console.log(`DRY RUN complete: ${toUpdate.length} lead(s) would be updated, ${uniqueLeads.length - toUpdate.length} already opted out.`)
    console.log(`Run with --apply to write changes.`)
    return
  }

  // Apply
  let updated = 0
  let skipped = 0
  for (const m of uniqueLeads) {
    if (m.lead.isOptedOut) { skipped++; continue }

    await p.lead.update({
      where: { id: m.leadId },
      data:  { status: 'OPTED_OUT', isOptedOut: true, optedOutAt: new Date() }
    })

    // Update every matching NO_ANSWER call for this lead, not just the latest
    const allCallsForLead = matches.filter(c => c.leadId === m.leadId)
    for (const c of allCallsForLead) {
      await p.call.update({
        where: { id: c.id },
        data:  { outcome: 'OPTED_OUT' }
      })
    }

    console.log(`  Updated: ${m.lead.name} (${m.lead.phone}) — ${allCallsForLead.length} call(s) corrected`)
    updated++
  }

  console.log(`\nDone. ${updated} lead(s) marked OPTED_OUT. ${skipped} already were.`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => p.$disconnect())
