const cron = require('node-cron')
const prisma = require('../lib/prisma')
const { getCredits } = require('../services/platformCredits')

const EL_LOW_THRESHOLD = 5000   // chars remaining → alert
const VAPI_HIGH_THRESHOLD = 5   // USD monthly spend → alert

async function checkCredits() {
  try {
    console.log('[creditMonitor] Checking platform credits...')
    if (!prisma.adminAlert) {
      console.log('[creditMonitor] adminAlert model not available — skipping alert checks')
      return
    }
    const { elevenlabs, vapi } = await getCredits(true)

    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    // ElevenLabs: alert when chars remaining drops below threshold
    if (elevenlabs && !elevenlabs.error && elevenlabs.charactersRemaining < EL_LOW_THRESHOLD) {
      const existing = await prisma.adminAlert.findFirst({
        where: { type: 'ELEVENLABS_LOW', isRead: false, createdAt: { gte: todayStart } },
      })
      if (!existing) {
        await prisma.adminAlert.create({
          data: {
            type: 'ELEVENLABS_LOW',
            title: 'ElevenLabs credits low',
            message: `Only ${elevenlabs.charactersRemaining.toLocaleString()} characters remaining out of ${elevenlabs.charactersLimit.toLocaleString()} (${elevenlabs.tier} plan). Top up to avoid voice call failures.`,
          },
        })
        console.log('[creditMonitor] ⚠️  Created ELEVENLABS_LOW alert — remaining:', elevenlabs.charactersRemaining)
      }
    }

    // VAPI: alert when monthly spend exceeds threshold
    if (vapi && !vapi.error && vapi.monthlySpend !== null && vapi.monthlySpend > VAPI_HIGH_THRESHOLD) {
      const existing = await prisma.adminAlert.findFirst({
        where: { type: 'VAPI_HIGH', isRead: false, createdAt: { gte: todayStart } },
      })
      if (!existing) {
        await prisma.adminAlert.create({
          data: {
            type: 'VAPI_HIGH',
            title: 'VAPI spend exceeds $5',
            message: `VAPI spend this month (${vapi.billingPeriod}): $${vapi.monthlySpend.toFixed(2)} — has exceeded the $${VAPI_HIGH_THRESHOLD} alert threshold.`,
          },
        })
        console.log('[creditMonitor] ⚠️  Created VAPI_HIGH alert — spend:', vapi.monthlySpend)
      }
    }

    console.log(`[creditMonitor] Done — EL remaining: ${elevenlabs?.charactersRemaining ?? 'n/a'} | VAPI spend: $${vapi?.monthlySpend ?? 'n/a'}`)
  } catch (err) {
    console.error('[creditMonitor] Error during credit check:', err.message)
  }
}

function startCreditMonitor() {
  // Check immediately on startup, then every 30 minutes
  checkCredits()
  cron.schedule('*/30 * * * *', checkCredits)
  console.log('[creditMonitor] Started — checking every 30 minutes (EL < 5,000 chars | VAPI > $5/month)')
}

module.exports = { startCreditMonitor }
