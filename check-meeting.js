require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

p.call.findMany({
  where: { outcome: 'BOOKED' },
  select: { id: true, meetingBookedAt: true, scheduledMeetingAt: true, summary: true }
}).then(calls => {
  console.table(calls.map(c => ({
    id: c.id,
    meetingBookedAt: c.meetingBookedAt?.toISOString() ?? 'null',
    scheduledMeetingAt: c.scheduledMeetingAt?.toISOString() ?? 'NULL — needs patch'
  })))
  return p.$disconnect()
})
