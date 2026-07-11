require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const BAD_VOICE_IDS = ['6zTSSmjcA6aoLN7aoJxA', 'E0XoH39bCKHkhWXXGfYF']
const SAFE_VOICE = '21m00Tcm4TlvDq8ikWAM' // Rachel — exists on all accounts

p.script.updateMany({
  where: { voiceId: { in: BAD_VOICE_IDS } },
  data: { voiceId: SAFE_VOICE }
})
.then(r => console.log('Fixed scripts:', r.count))
.catch(e => console.error('Error:', e.message))
.finally(() => p.$disconnect())
