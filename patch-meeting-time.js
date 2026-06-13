require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

// Patch the existing booked call with the meeting time the AI agreed to.
// The transcript says "Wednesday at 10PM" — that's June 18, 2026 22:00 IST = 16:30 UTC
// Adjust this if the actual agreed time was different.
const CALL_ID = 'cmqc0omb80003ylyzjwhoee69'
const SCHEDULED_AT = new Date('2026-06-18T22:00:00+05:30') // Wednesday 10 PM IST

p.call.update({
  where: { id: CALL_ID },
  data: { scheduledMeetingAt: SCHEDULED_AT }
}).then(r => {
  console.log('Patched call', r.id, '— scheduledMeetingAt:', r.scheduledMeetingAt)
  return p.$disconnect()
}).catch(e => { console.error(e); p.$disconnect() })
