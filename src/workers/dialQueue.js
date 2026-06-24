// ============================================================
// FIX-03 + language fix — backend/src/workers/dialQueue.js
//
// WHAT CHANGED vs prior version:
//   1. MAX_CONCURRENT now read from env (was hardcoded 10)
//      Set MAX_CONCURRENT_CALLS=20 in .env to scale up
//   2. Call timeout added — marks call PENDING if Vapi hangs
//   3. Better error logging with lead info attached
//   4. Job timeout: 45 seconds per call attempt (was unlimited)
//   5. Script language fetched + passed to vapiService so language-aware
//      greeting (BUG-D fix in vapi.js) fires correctly on outbound calls
// ============================================================

const { Queue, Worker } = require('bullmq')
const { PrismaClient } = require('@prisma/client')
const { parsePhoneNumberFromString } = require('libphonenumber-js')
const vapiService = require('../services/vapi')

const prisma = new PrismaClient()

const REDIS_URL        = process.env.REDIS_URL || 'redis://localhost:6379'
const MAX_CONCURRENT   = parseInt(process.env.MAX_CONCURRENT_CALLS || '10', 10)
const CALLS_PER_MINUTE = parseInt(process.env.CALLS_PER_MINUTE     || '2',  10)

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

async function cleanupStaleCalls() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000) // 15 min — any AI call stuck longer than this means Vapi never sent end-of-call-report
  const stale = await prisma.call.findMany({
    where: {
      status: { in: ['IN_PROGRESS', 'RINGING', 'INITIATED'] },
      createdAt: { lt: cutoff }
    }
  })
  if (stale.length === 0) return
  console.log(`[dialQueue] Cleaning up ${stale.length} stale call(s) older than 15 min — Vapi end webhook likely never arrived`)
  for (const call of stale) {
    await prisma.call.update({
      where: { id: call.id },
      data: { status: 'COMPLETED', outcome: 'NO_ANSWER', durationSeconds: 0, endedAt: new Date() }
    }).catch(() => {})
    await prisma.lead.update({
      where: { id: call.leadId },
      data: { status: 'NO_ANSWER' }
    }).catch(() => {})
  }
}

async function runScheduler(campaignId = null) {
  await cleanupStaleCalls()
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

    // Build lead query:
    //   - Explicit scheduled callbacks (callbackAt set + time has arrived) → always dial,
    //     even on Sunday or outside calling hours, because the lead specifically asked.
    //   - All other leads (PENDING, NO_ANSWER, VOICEMAIL, null-callbackAt CALLBACK) →
    //     only during configured calling hours/days.
    const leads = await prisma.lead.findMany({
      where: {
        campaignId: campaign.id,
        isOptedOut: false,
        callAttempts: { lt: campaign.maxAttempts },
        OR: [
          // Explicit scheduled callback — bypass calling hours entirely
          {
            status: 'CALLBACK',
            callbackAt: { not: null, lte: now }
          },
          // Everything else — only when within calling hours
          ...(withinHours ? [
            {
              status: { in: ['PENDING', 'NO_ANSWER', 'VOICEMAIL'] },
              OR: [
                { lastCalledAt: null },
                { lastCalledAt: { lte: retryThreshold } }
              ]
            },
            {
              status: 'CALLBACK',
              callbackAt: null,
              OR: [
                { lastCalledAt: null },
                { lastCalledAt: { lte: retryThreshold } }
              ]
            }
          ] : [])
        ]
      },
      take: 50
    })

    if (leads.length === 0) {
      if (!withinHours) {
        const inTz    = new Date(now.toLocaleString('en-US', { timeZone: campaign.timezone }))
        const hour    = inTz.getHours()
        const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][inTz.getDay()]
        console.log(`[dialQueue] Campaign "${campaign.name}" — outside hours (${dayName} ${hour}:00) and no scheduled callbacks due`)
      }
      continue
    }

    const callbackCount = leads.filter(l => l.status === 'CALLBACK' && l.callbackAt).length
    console.log(`[dialQueue] Campaign "${campaign.name}" — ${leads.length} lead(s) eligible${callbackCount ? ` (${callbackCount} scheduled callback${callbackCount > 1 ? 's' : ''})` : ''}`)

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
        timeout: 45000   // 45s hard timeout per job — prevents zombie calls
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

  // Fetch script language so it can be passed through to vapiService —
  // needed so the language-aware greeting (BUG-D in vapi.js) fires correctly
  // even when a per-call voice override (clonedVoiceId) is used.
  let scriptLanguage = 'en'
  let scriptGender = 'female'
  let systemPromptOverride = null
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { script: { select: { compiledPrompt: true, language: true, agentGender: true } } }
    })
    scriptLanguage = campaign?.script?.language || 'en'
    scriptGender   = campaign?.script?.agentGender || 'female'

    if (priorCalls.length > 0) {
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
    }
  } catch (err) {
    console.error(`[dialQueue] Could not build call history / fetch script language for lead ${leadId}:`, err.message)
  }

  const vapiCall = await vapiService.startOutboundCall({
    toNumber, vapiNumberId, vapiAssistantId,
    voiceOverrideId: clonedVoiceId || undefined,
    systemPromptOverride,
    language: scriptLanguage,
    agentGender: scriptGender,
    metadata: { tenantId, leadId, campaignId, callRecordId: callRecord.id, leadName, leadCompany, leadTitle }
  })

  await prisma.call.update({
    where: { id: callRecord.id },
    // startedAt here is DIAL time, not ANSWER time — Vapi hasn't connected yet.
    // This gets overwritten by handleCallStarted() in webhooks.js once the call
    // actually connects (status: IN_PROGRESS).
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
  // Run cleanup immediately on startup — catches stale calls from any previous session
  // where the server was restarted without Vapi sending end-of-call-report webhooks
  await cleanupStaleCalls().catch(err => console.error('[dialQueue] Startup cleanup failed:', err.message))

  await schedulerQueue.add('scan-campaigns', {}, {
    repeat: { every: 5 * 60 * 1000 },
    jobId: 'recurring-scan'
  })

  schedulerWorker = new Worker('dial-scheduler', async () => {
    await runScheduler()
  }, { connection })

  callWorker = new Worker('dial-calls', dialLead, {
    connection,
    concurrency: MAX_CONCURRENT,
    limiter: { max: CALLS_PER_MINUTE, duration: 60 * 1000 }
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

  console.log(`[dialQueue] Workers started — concurrency: ${MAX_CONCURRENT}, rate: ${CALLS_PER_MINUTE}/min, scheduler: every 5min`)
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
