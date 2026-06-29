require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function go() {
  const tenants = await p.tenant.findMany({ select: { id: true, name: true, status: true, ownerEmail: true } })
  console.log('=== ALL TENANTS ===')
  tenants.forEach(t => console.log(t.id, '|', t.name, '|', t.status, '|', t.ownerEmail))

  const lists = await p.waContactList.findMany({ select: { id: true, tenantId: true, name: true, totalContacts: true } })
  console.log('\n=== WA CONTACT LISTS ===')
  if (lists.length === 0) console.log('  (none)')
  lists.forEach(l => console.log(l.id, '|', l.tenantId, '|', l.name, '| contacts:', l.totalContacts))

  const grouped = await p.lead.groupBy({ by: ['status', 'tenantId'], _count: { _all: true } })
  console.log('\n=== LEAD STATUS COUNTS PER TENANT ===')
  grouped.forEach(g => console.log(g.tenantId, '|', g.status, ':', g._count._all))
}

go().catch(e => { console.error(e.message); process.exit(1) }).finally(() => p.$disconnect())
