// backend/src/workers/dialQueue.js
// Bull queue that picks up leads from active campaigns and dials them
// Respects calling hours, timezones, retry rules, and DNC

const Bull = require('bull')
const { PrismaClient } = require('@prisma/client')
const vapiService = require('../services/vapi')
const { parsePhoneNumberFromString } = require('libphonenumber-js')

const prisma = new PrismaClient()

// One queue for scheduling, one for actual dialling
const scheduleQueue = new Bull('schedule-dial', process.env.REDIS_URL)
const dialQueue    = new Bull('dial-lead',     process.env.REDIS_URL)

// ── SCHEDULE WORKER ──────────────────────────────────────
// Runs every 5 minutes, checks all active campaigns and
// enqueues leads that should be called right now

scheduleQueue.process(async (job) => {
  const now = new Date()

  const activeCampaigns = await prisma.campaign.findMany({
    where: { status: 'ACTIVE' },
    include: {
      script: true,
      tenant: { include: { phoneNumbers: { where: { isActive: true } } } }
    }
  })

  for (const campaign of activeCampaigns) {
    if (!campaign.script?.isActive) continue
    if (!isWithinCallingHours(campaign, now)) continue

    // Get pending leads for this campaign (not currently being called)
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
      take: 50  // batch size — dial 50 at a time per campaign
    })

    for (const lead of leads) {
      // Pick the right phone number for this lead's country
      const fromNumber = pickNumberForLead(campaign.tenant.phoneNumbers, lead.country)
      if (!fromNumber) {
        console.warn(`[dialQueue] No number for country ${lead.country} — tenant ${campaign.tenantId}`)
        continue
      }

      // Get Vapi assistant ID from the compiled prompt metadata
      let vapiAssistantId
      try {
        const meta = JSON.parse(campaign.script.compiledPrompt || '{}')
        vapiAssistantId = meta.vapiAssistantId
      } catch { continue }

      if (!vapiAssistantId) continue

      // Enqueue the actual dial job with a small delay to avoid slamming the API
      await dialQueue.add(
        {
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
        },
        {
          attempts: 1,         // don't retry job — retry logic is at the lead level
          removeOnComplete: true,
          removeOnFail: false
        }
      )

      // Mark lead as CALLING so we don't pick it up again
      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: 'CALLING' }
      })
    }
  }
})

// ── DIAL WORKER ──────────────────────────────────────────
// Actually triggers the Vapi call for one lead

dialQueue.process(10, async (job) => {  // 10 concurrent dials max
  const {
    leadId, campaignId, tenantId,
    toNumber, fromNumberId, fromNumber,
    vapiAssistantId,
    leadName, leadCompany, leadTitle
  } = job.data

  // Validate phone number
  const parsed = parsePhoneNumberFromString(toNumber)
  if (!parsed || !parsed.isValid()) {
    await prisma.lead.update({
      where: { id: leadId },
      data: { status: 'WRONG_NUMBER' }
    })
    return
  }

  try {
    // Create call record first
    const callRecord = await prisma.call.create({
      data: {
        tenantId, leadId, campaignId,
        phoneNumberId: fromNumberId,
        status: 'INITIATED',
        direction: 'outbound'
      }
    })

    // Fire the call via Vapi
    const vapiCall = await vapiService.startOutboundCall({
      toNumber,
      fromNumber,
      vapiAssistantId,
      metadata: {
        tenantId, leadId, campaignId,
        callRecordId: callRecord.id,
        leadName, leadCompany, leadTitle
      }
    })

    // Update call record with Vapi call ID
    await prisma.call.update({
      where: { id: callRecord.id },
      data: {
        vapiCallId: vapiCall.id,
        status: 'RINGING',
        startedAt: new Date()
      }
    })

    // Update lead call count
    await prisma.lead.update({
      where: { id: leadId },
      data: {
        callAttempts: { increment: 1 },
        lastCalledAt: new Date()
      }
    })

  } catch (err) {
    console.error(`[dialQueue] Call failed for lead ${leadId}:`, err.message)
    await prisma.lead.update({
      where: { id: leadId },
      data: { status: 'PENDING' }  // reset so it retries next cycle
    })
  }
})

// ── HELPERS ──────────────────────────────────────────────

function isWithinCallingHours(campaign, now) {
  // Convert now to campaign timezone
  const inTz = new Date(now.toLocaleString('en-US', { timeZone: campaign.timezone }))
  const hour = inTz.getHours()
  const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
  const dayName  = dayNames[inTz.getDay()]
  const callDays = campaign.callDays.split(',')

  return (
    callDays.includes(dayName) &&
    hour >= campaign.callFromHour &&
    hour < campaign.callToHour
  )
}

function pickNumberForLead(phoneNumbers, country) {
  // First try: default number for this country
  const def = phoneNumbers.find(n => n.country === country && n.isDefault && n.isActive)
  if (def) return def
  // Fallback: any active number for this country
  const any = phoneNumbers.find(n => n.country === country && n.isActive)
  if (any) return any
  // Last resort: any active number at all
  return phoneNumbers.find(n => n.isActive) || null
}

// ── START ────────────────────────────────────────────────

function startWorker() {
  // Run scheduler every 5 minutes
  scheduleQueue.add({}, { repeat: { cron: '*/5 * * * *' }, removeOnComplete: true })
  console.log('[dialQueue] Worker started — scheduling every 5 minutes')
}

// Public API for manually triggering a campaign check
async function triggerCampaign(campaignId) {
  await scheduleQueue.add({ campaignId }, { priority: 1 })
}

// Public API for pausing all calls for a tenant
async function pauseTenant(tenantId) {
  const jobs = await dialQueue.getJobs(['waiting', 'delayed'])
  for (const job of jobs) {
    if (job.data.tenantId === tenantId) await job.remove()
  }
}

module.exports = { startWorker, triggerCampaign, pauseTenant, dialQueue, scheduleQueue }
