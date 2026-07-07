// One-time script: reset 85 leads wrongly marked OPTED_OUT due to the
// formatTranscript() system-prompt bug (fixed in PR #1, merged 2026-07-07).
//
// Two groups:
//   Group A — 79 leads opted-out today whose transcripts contained system-prompt
//             phrases; reset to PENDING so they get called again.
//   Group B — 6 leads that already had meetingBookedAt set but were flipped to
//             OPTED_OUT by the same bug; reset back to BOOKED.

require('dotenv').config()
const prisma = require('../src/lib/prisma')

async function main() {
  // The bad session ran on 2026-07-06 UTC (evening IST = next calendar day locally)
  const todayStart = new Date('2026-07-06T00:00:00.000Z')

  // ── Group A: opted-out today, no meeting booked ───────────────────────────
  const groupA = await prisma.lead.findMany({
    where: {
      status:         'OPTED_OUT',
      isOptedOut:     true,
      optedOutAt:     { gte: todayStart },
      meetingBookedAt: null,
    },
    select: { id: true, name: true, phone: true, optedOutAt: true }
  })

  // ── Group B: booked meetings that were wrongly flipped to OPTED_OUT ───────
  const groupB = await prisma.lead.findMany({
    where: {
      status:          'OPTED_OUT',
      isOptedOut:      true,
      meetingBookedAt: { not: null },
    },
    select: { id: true, name: true, phone: true, meetingBookedAt: true }
  })

  console.log(`\nGroup A (reset to PENDING): ${groupA.length} leads`)
  console.log(`Group B (reset to BOOKED):  ${groupB.length} leads`)

  if (groupA.length === 0 && groupB.length === 0) {
    console.log('\nNothing to reset — exiting.')
    return
  }

  // ── Reset Group A → PENDING ───────────────────────────────────────────────
  if (groupA.length > 0) {
    const result = await prisma.lead.updateMany({
      where: { id: { in: groupA.map(l => l.id) } },
      data: {
        status:       'PENDING',
        isOptedOut:   false,
        optedOutAt:   null,
        callAttempts: 0,
        lastCalledAt: null,
      }
    })
    console.log(`\n✓ Reset ${result.count} leads → PENDING`)
    groupA.forEach(l =>
      console.log(`  - ${l.name} | ${l.phone} | opted-out at ${l.optedOutAt?.toISOString()}`)
    )
  }

  // ── Reset Group B → BOOKED ────────────────────────────────────────────────
  if (groupB.length > 0) {
    const result = await prisma.lead.updateMany({
      where: { id: { in: groupB.map(l => l.id) } },
      data: {
        status:     'BOOKED',
        isOptedOut: false,
        optedOutAt: null,
      }
    })
    console.log(`\n✓ Reset ${result.count} leads → BOOKED`)
    groupB.forEach(l =>
      console.log(`  - ${l.name} | ${l.phone} | meeting at ${l.meetingBookedAt?.toISOString()}`)
    )
  }

  console.log('\nDone.')
}

main().catch(console.error).finally(() => prisma.$disconnect())
