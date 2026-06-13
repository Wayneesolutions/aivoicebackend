require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

// Resets all non-terminal leads back to PENDING so the scheduler will retry them.
// Terminal statuses (BOOKED, OPTED_OUT) are preserved.
p.lead.updateMany({
  where: { status: { notIn: ['BOOKED', 'OPTED_OUT'] } },
  data: { status: 'PENDING', callAttempts: 0, lastCalledAt: null }
}).then(r => {
  console.log('Reset', r.count, 'lead(s) back to PENDING')
  return p.$disconnect()
})
