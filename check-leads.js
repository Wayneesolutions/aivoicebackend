require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

p.lead.findMany({
  select: { id: true, name: true, phone: true, status: true, callAttempts: true, lastCalledAt: true, isOptedOut: true },
  orderBy: { createdAt: 'desc' },
  take: 20
}).then(leads => {
  console.table(leads.map(l => ({
    name: l.name,
    phone: l.phone,
    status: l.status,
    attempts: l.callAttempts,
    lastCalled: l.lastCalledAt?.toISOString() ?? 'never',
    optedOut: l.isOptedOut
  })))
  return p.$disconnect()
})
