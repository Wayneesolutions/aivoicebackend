require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
p.lead.updateMany({
  where: { status: 'CALLING' },
  data: { status: 'PENDING', callAttempts: 0, lastCalledAt: null }
}).then(r => {
  console.log('Reset', r.count, 'lead(s) back to PENDING')
  return p.$disconnect()
})
