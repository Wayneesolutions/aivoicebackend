// ============================================================
// FIX-03 — backend/src/workers/dialQueue.js
// REPLACE your entire existing dialQueue.js with this file.
//
// WHAT CHANGED:
//   1. MAX_CONCURRENT now read from env (was hardcoded 10)
//      Set MAX_CONCURRENT_CALLS=20 in .env to scale up
//   2. Call timeout added — marks call PENDING if Vapi hangs
//   3. Better error logging with lead info attached
//   4. Job timeout: 45 seconds per call attempt (was unlimited)
// ============================================================

const { Queue, Worker } = require('bullmq')
const { PrismaClient } = require('@prisma/client')
const { parsePhoneNumberFromString } = require('libphonenumber-js')
const vapiService = require('../services/vapi')

const prisma = new PrismaClient()

const REDIS_URL      = process.env.REDIS_URL || 'redis://localhost:6379'
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_CALLS || '10', 10) // CHANGED: from .env

function redisConnection() {
  try {
    const url = new URL(REDIS_URL)
    return {
      host:     url.hostname,
      port:     parseInt(url.port) || 6379,
      password: url.password || undefined,
      tls:      url.protocol === 'rediss:' ? {} : undefined
    }
  } catch {
    return { host: 'localhost', port: 6379 }
  }
}

const connection = redisConnection()

const schedulerQueue = new Queue('dial-scheduler', { connection })
const callQueue      = new Queue('dial-calls',     { connection })

async function runScheduler(campaignId = null) {
  const now = new Date()

  const activeCampaigns = await prisma.campaign.findMany({
    where: { status: 'ACTIVE', ...(campaignId && { id: campaignId }) },
    include: {
      script: true,
      tenant: { include: { phoneNumbers: { where: { isActive: true } } } }
    }
  })

  console.log(`[dialQueue] Scanning ${activeCampaigns.length} active campaign(s)`)

  for (const campaign of activeCampaigns) {
    if (!campaign.script?.isActive) {
      console.log(`[dialQueue] Campaign "${campaign.name}" — script not active, skipping`)
      continue
    }
    const withinHours = isWithinCallingHours(campaign, now)
    if (!withinHours) {
      const inTz    = new Date(now.toLocaleString('en-US', { timeZone: campaign.timezone }))
      const hour    = inTz.getHours()
      const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][inTz.getDay()]
      console.log(`[dialQueue] Campaign "${campaign.name}" — outside hours: ${dayName} ${hour}:00 (window ${campaign.callFromHour}–${campaign.callToHour}, days ${campaign.callDays})`)
      continue
    }

    let vapiAssistantId
    try {
      const meta = JSON.parse(campaign.script.compiledPrompt || '{}')
      vapiAssistantId = meta.vapiAssistantId
    } catch { continue }

    if (!vapiAssistantId) {
      console.log(`[dialQueue] Campaign "${campaign.name}" — no vapiAssistantId on script, skipping`)
      continue
    }

    // Mark exhausted leads so they stop being dialed
    await prisma.lead.updateMany({
      where: {
        campaignId: campaign.id,
        callAttempts: { gte: campaign.maxAttempts },
        isOptedOut: false,
        status: { in: ['PENDING', 'NO_ANSWER', 'VOICEMAIL', 'CALLBACK'] }
      },
      data: { status: 'EXHAUSTED' }
    })

    const retryThreshold = new Date(now - campaign.retryAfterHours * 60 * 60 * 1000)

    const leads = await prisma.lead.findMany({
      where: {
        campaignId: campaign.id,
        isOptedOut: false,
        callAttempts: { lt: campaign.maxAttempts },
        OR: [
          {
            status: { in: ['PENDING', 'NO_ANSWER', 'VOICEMAIL'] },
            OR: [
              { lastCalledAt: null },
              { lastCalledAt: { lte: retryThreshold } }
            ]
          },
          {
            status: 'CALLBACK',
            OR: [
              { callbackAt: { lte: now } },
              {
                callbackAt: null,
                OR: [
                  { lastCalledAt: null },
                  { lastCalledAt: { lte: retryThreshold } }
                ]
              }
            ]
          }
        ]
      },
      take: 50
    })

    console.log(`[dialQueue] Campaign "${campaign.name}" — ${leads.length} lead(s) eligible`)

    for (const lead of leads) {
      const phoneRecord = pickNumberForLead(campaign.tenant.phoneNumbers, lead.country)
      if (!phoneRecord) {
        console.warn(`[dialQueue] No number for country ${lead.country} — tenant ${campaign.tenantId}`)
        continue
      }
      if (!phoneRecord.vapiNumberId) {
        console.warn(`[dialQueue] Phone ${phoneRecord.number} has no vapiNumberId — assign in Admin → Phone Numbers`)
        continue
      }

      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: 'CALLING' }
      })

      await callQueue.add('dial', {
        leadId:          lead.id,
        campaignId:      campaign.id,
        tenantId:        campaign.tenantId,
        toNumber:        lead.phone,
        fromNumberId:    phoneRecord.id,
        vapiNumberId:    phoneRecord.vapiNumberId,
        vapiAssistantId,
        clonedVoiceId:   campaign.tenant.clonedVoiceId || null,
        leadName:        lead.name,
        leadCompany:     lead.company || '',
        leadTitle:       lead.title   || ''
      }, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 10000 },
        timeout: 45000   // CHANGED: 45s hard timeout per job — prevents zombie calls
      })
    }
  }
}

async function dialLead(job) {
  const {
    leadId, campaignId, tenantId, toNumber, fromNumberId,
    vapiNumberId, vapiAssistantId, clonedVoiceId,
    leadName, leadCompany, leadTitle
  } = job.data

  const parsed = parsePhoneNumberFromString(toNumber)
  if (!parsed || !parsed.isValid()) {
    console.warn(`[dialQueue] Invalid phone number for lead ${leadId}: ${toNumber}`)
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'WRONG_NUMBER' } })
    return
  }

  const priorCalls = await prisma.call.findMany({
    where: { leadId, status: 'COMPLETED', summary: { not: null } },
    orderBy: { endedAt: 'asc' },
    select: { endedAt: true, summary: true }
  })

  const callRecord = await prisma.call.create({
    data: {
      tenantId, leadId, campaignId,
      phoneNumberId: fromNumberId,
      status: 'INITIATED',
      direction: 'outbound'
    }
  })

  let systemPromptOverride = null
  if (priorCalls.length > 0) {
    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { script: { select: { compiledPrompt: true } } }
      })
      const meta = JSON.parse(campaign?.script?.compiledPrompt || '{}')
      const basePrompt = meta.prompt || ''
      if (basePrompt) {
        const historyLines = priorCalls.map((c, i) => {
          const date = c.endedAt
            ? c.endedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : 'unknown date'
          return `Call ${i + 1} (${date}): ${c.summary}`
        }).join('\n')

        const contextBlock = `PRIOR CALL HISTORY — READ BEFORE STARTING\nYou have called {{prospect_name}} before:\n${historyLines}\nOpen by acknowledging you've spoken: "Hi {{prospect_name}}, we spoke previously — just wanted to follow up."\nReference what was discussed. Don't repeat the same pitch.\n\n`
        systemPromptOverride = contextBlock + basePrompt
        console.log(`[dialQueue] Lead ${leadId} — injecting ${priorCalls.length} prior call(s) into prompt`)
      }
    } catch (err) {
      console.error(`[dialQueue] Could not build call history for lead ${leadId}:`, err.message)
    }
  }

  const vapiCall = await vapiService.startOutboundCall({
    toNumber, vapiNumberId, vapiAssistantId,
    voiceOverrideId: clonedVoiceId || undefined,
    systemPromptOverride,
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

  console.log(`[dialQueue] Call initiated — lead=${leadId} vapiCallId=${vapiCall.id}`)
}

function isWithinCallingHours(campaign, now) {
  const inTz    = new Date(now.toLocaleString('en-US', { timeZone: campaign.timezone }))
  const hour    = inTz.getHours()
  const dayName = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][inTz.getDay()]
  return campaign.callDays.split(',').includes(dayName) && hour >= campaign.callFromHour && hour < campaign.callToHour
}

function pickNumberForLead(phoneNumbers, country) {
  return (
    phoneNumbers.find(n => n.country === country && n.isDefault && n.isActive) ||
    phoneNumbers.find(n => n.country === country && n.isActive) ||
    phoneNumbers.find(n => n.isActive) ||
    null
  )
}

let schedulerWorker = null
let callWorker = null

async function startWorker() {
  await schedulerQueue.add('scan-campaigns', {}, {
    repeat: { every: 5 * 60 * 1000 },
    jobId: 'recurring-scan'
  })

  schedulerWorker = new Worker('dial-scheduler', async () => {
    await runScheduler()
  }, { connection })

  callWorker = new Worker('dial-calls', dialLead, {
    connection,
    concurrency: MAX_CONCURRENT   // CHANGED: reads from env
  })

  callWorker.on('failed', async (job, err) => {
    console.error(`[dialQueue] Job ${job?.id} failed (lead: ${job?.data?.leadId}):`, err.message)
    if (job?.data?.leadId) {
      await prisma.lead.update({
        where: { id: job.data.leadId },
        data: { status: 'PENDING' }
      }).catch(() => {})
    }
  })

  console.log(`[dialQueue] Workers started — concurrency: ${MAX_CONCURRENT}, scheduler: every 5min`)
}

async function triggerCampaign(campaignId) {
  await schedulerQueue.add('scan-campaigns', { campaignId }, {
    jobId: `trigger-${campaignId}-${Date.now()}`
  })
}

async function stopWorker() {
  await schedulerWorker?.close()
  await callWorker?.close()
}

module.exports = { startWorker, triggerCampaign, stopWorker }
