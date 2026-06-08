const { PrismaClient } = require('@prisma/client')
const vapiService = require('../services/vapi')
const { parsePhoneNumberFromString } = require('libphonenumber-js')

const prisma = new PrismaClient()

const MAX_CONCURRENT = 10
let activeDials = 0
const pausedTenants = new Set()

async function runScheduler(campaignId = null) {
  const now = new Date()

  const activeCampaigns = await prisma.campaign.findMany({
    where: { status: 'ACTIVE', ...(campaignId && { id: campaignId }) },
    include: {
      script: true,
      tenant: { include: { phoneNumbers: { where: { isActive: true } } } }
    }
  })

  for (const campaign of activeCampaigns) {
    if (!campaign.script?.isActive) continue
    if (!isWithinCallingHours(campaign, now)) continue
    if (pausedTenants.has(campaign.tenantId)) continue

    const leads = await prisma.lead.findMany({
      where: {
        campaignId: campaign.id,
        status: { in: ['PENDING', 'NO_ANSWER', 'VOICEMAIL'] },
        isOptedOut: false,
        callAttempts: { lt: campaign.maxAttempts },
        OR: [
          { lastCalledAt: null },
          { lastCalledAt: { lte: new Date(now - campaign.retryAfterHours * 60 * 60 * 1000) } }
        ]
      },
      take: 50
    })

    for (const lead of leads) {
      const fromNumber = pickNumberForLead(campaign.tenant.phoneNumbers, lead.country)
      if (!fromNumber) {
        console.warn(`[dialQueue] No number for country ${lead.country} — tenant ${campaign.tenantId}`)
        continue
      }

      let vapiAssistantId
      try {
        const meta = JSON.parse(campaign.script.compiledPrompt || '{}')
        vapiAssistantId = meta.vapiAssistantId
      } catch { continue }

      if (!vapiAssistantId) continue

      // Wait if at concurrency limit
      while (activeDials >= MAX_CONCURRENT) {
        await new Promise(r => setTimeout(r, 500))
      }

      // Mark lead before firing so the next loop iteration skips it
      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: 'CALLING' }
      })

      dialLead({
        leadId:          lead.id,
        campaignId:      campaign.id,
        tenantId:        campaign.tenantId,
        toNumber:        lead.phone,
        fromNumberId:    fromNumber.id,
        fromNumber:      fromNumber.number,
        vapiAssistantId,
        leadName:        lead.name,
        leadCompany:     lead.company || '',
        leadTitle:       lead.title  || ''
      }).catch(err => console.error('[dialQueue] Unhandled dial error:', err.message))
    }
  }
}

async function dialLead({ leadId, campaignId, tenantId, toNumber, fromNumberId, fromNumber, vapiAssistantId, leadName, leadCompany, leadTitle }) {
  activeDials++
  try {
    const parsed = parsePhoneNumberFromString(toNumber)
    if (!parsed || !parsed.isValid()) {
      await prisma.lead.update({ where: { id: leadId }, data: { status: 'WRONG_NUMBER' } })
      return
    }

    const callRecord = await prisma.call.create({
      data: {
        tenantId, leadId, campaignId,
        phoneNumberId: fromNumberId,
        status: 'INITIATED',
        direction: 'outbound'
      }
    })

    const vapiCall = await vapiService.startOutboundCall({
      toNumber, fromNumber, vapiAssistantId,
      metadata: { tenantId, leadId, campaignId, callRecordId: callRecord.id, leadName, leadCompany, leadTitle }
    })

    await prisma.call.update({
      where: { id: callRecord.id },
      data: { vapiCallId: vapiCall.id, status: 'RINGING', startedAt: new Date() }
    })

    await prisma.lead.update({
      where: { id: leadId },
      data: { callAttempts: { increment: 1 }, lastCalledAt: new Date() }
    })

  } catch (err) {
    console.error(`[dialQueue] Call failed for lead ${leadId}:`, err.message)
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'PENDING' } })
  } finally {
    activeDials--
  }
}

function isWithinCallingHours(campaign, now) {
  const inTz    = new Date(now.toLocaleString('en-US', { timeZone: campaign.timezone }))
  const hour    = inTz.getHours()
  const dayName = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][inTz.getDay()]
  const callDays = campaign.callDays.split(',')
  return callDays.includes(dayName) && hour >= campaign.callFromHour && hour < campaign.callToHour
}

function pickNumberForLead(phoneNumbers, country) {
  return (
    phoneNumbers.find(n => n.country === country && n.isDefault && n.isActive) ||
    phoneNumbers.find(n => n.country === country && n.isActive) ||
    phoneNumbers.find(n => n.isActive) ||
    null
  )
}

function startWorker() {
  setInterval(() => {
    runScheduler().catch(err => console.error('[dialQueue] Scheduler error:', err.message))
  }, 5 * 60 * 1000)
  console.log('[dialQueue] Worker started — scheduling every 5 minutes')
}

async function triggerCampaign(campaignId) {
  await runScheduler(campaignId)
}

function pauseTenant(tenantId) {
  pausedTenants.add(tenantId)
}

module.exports = { startWorker, triggerCampaign, pauseTenant }
