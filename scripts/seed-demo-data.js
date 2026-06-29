/**
 * seed-demo-data.js
 *
 * Promotes a small batch of existing NO_ANSWER leads to CALLBACK and BOOKED
 * so the Callback List and WhatsApp Contacts pages show real data.
 *
 * Safe to run multiple times — skips leads that are already promoted,
 * and skips WaContacts that already exist.
 *
 * Usage:
 *   node scripts/seed-demo-data.js
 */

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const CALLBACK_COUNT  = 8   // how many leads to mark CALLBACK
const BOOKED_COUNT    = 6   // how many leads to mark BOOKED (also → WA opted-in)
const WA_AUTO_LIST    = 'VoCallM Opted-In'

async function seedTenant(tenant) {
  console.log(`\n[seed] ── Tenant: ${tenant.name} (${tenant.ownerEmail}) ──`)

  // ── 1. Pull a pool of PENDING or NO_ANSWER leads ─────────────────────────────
  const pool = await prisma.lead.findMany({
    where:   { tenantId: tenant.id, status: { in: ['NO_ANSWER', 'PENDING'] }, phone: { not: '' } },
    orderBy: { createdAt: 'desc' },
    take:    CALLBACK_COUNT + BOOKED_COUNT,
  })

  if (pool.length === 0) {
    console.log('[seed]   No seedable leads — skipping')
    return
  }

  const callbackLeads = pool.slice(0, CALLBACK_COUNT)
  const bookedLeads   = pool.slice(CALLBACK_COUNT, CALLBACK_COUNT + BOOKED_COUNT)
  console.log(`[seed]   Pool: ${pool.length}  →  ${callbackLeads.length} CALLBACK + ${bookedLeads.length} BOOKED`)

  // ── 2. Mark CALLBACK leads ───────────────────────────────────────────────────
  const callbackAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  for (const lead of callbackLeads) {
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'CALLBACK', callbackAt } })
    await prisma.call.updateMany({ where: { leadId: lead.id }, data: { outcome: 'CALLBACK' } })
    console.log(`[seed]   CALLBACK → ${lead.name} (${lead.phone})`)
  }

  // ── 3. Mark BOOKED + bridge to WhatsApp ──────────────────────────────────────
  let waList = await prisma.waContactList.findFirst({ where: { tenantId: tenant.id, name: WA_AUTO_LIST } })
  if (!waList) {
    waList = await prisma.waContactList.create({ data: { tenantId: tenant.id, name: WA_AUTO_LIST, totalContacts: 0 } })
  }

  let waAdded = 0
  for (const lead of bookedLeads) {
    const now = new Date()
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'BOOKED', meetingBookedAt: now } })
    await prisma.call.updateMany({ where: { leadId: lead.id }, data: { outcome: 'BOOKED', meetingBookedAt: now } })

    const existing = await prisma.waContact.findFirst({ where: { contactListId: waList.id, phone: lead.phone } })
    if (!existing) {
      await prisma.$transaction([
        prisma.waContact.create({
          data: {
            contactListId: waList.id, tenantId: tenant.id,
            phone: lead.phone, fullName: lead.name || null, businessName: lead.company || null,
            optInStatus: 'OPTED_IN', optInSource: 'demo_seed', optInTimestamp: now,
          },
        }),
        prisma.waContactList.update({ where: { id: waList.id }, data: { totalContacts: { increment: 1 } } }),
      ])
      waAdded++
    }
    console.log(`[seed]   BOOKED   → ${lead.name} (${lead.phone})  [WA: ${existing ? 'exists' : 'added'}]`)
  }

  // Fix totalContacts drift
  const realCount = await prisma.waContact.count({ where: { contactListId: waList.id } })
  await prisma.waContactList.update({ where: { id: waList.id }, data: { totalContacts: realCount } })
  console.log(`[seed]   ✓ ${callbackLeads.length} callbacks, ${bookedLeads.length} booked, ${waAdded} WA contacts (list total: ${realCount})`)
}

async function main() {
  // Seed every active tenant that has at least one lead
  const tenants = await prisma.tenant.findMany({ where: { status: 'ACTIVE' } })

  const tenantIds = tenants.map(t => t.id)
  const withLeads = await prisma.lead.groupBy({
    by: ['tenantId'],
    where: { tenantId: { in: tenantIds } },
    _count: { _all: true },
  })
  const activeIds = new Set(withLeads.map(r => r.tenantId))
  const targets   = tenants.filter(t => activeIds.has(t.id))

  console.log(`[seed] Seeding ${targets.length} tenant(s) with leads...`)
  for (const tenant of targets) {
    await seedTenant(tenant)
  }

  console.log('\n[seed] ✅ All done — refresh Callback List and WhatsApp Contacts pages.')
}

main()
  .catch(err => { console.error('[seed] Fatal:', err.message); process.exit(1) })
  .finally(() => prisma.$disconnect())
