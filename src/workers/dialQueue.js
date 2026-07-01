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
      tls:      url.protocol === 'rediss:' ? {} : undefined,
      // Required for BullMQ: prevents MaxRetriesPerRequestError crashes.
      maxRetriesPerRequest: null,
      enableReadyCheck:     false,
      // Exponential backoff: 200ms → 400ms → 800ms … capped at 30s.
      // Prevents log-spam when Redis isn't up yet (e.g. Docker Desktop still starting).
      retryStrategy: (times) => Math.min(200 * Math.pow(2, times - 1), 30_000),
    }
  } catch {
    return {
      host: 'localhost', port: 6379,
      maxRetriesPerRequest: null, enableReadyCheck: false,
      retryStrategy: (times) => Math.min(200 * Math.pow(2, times - 1), 30_000),
    }
  }
}

const connection = redisConnection()

const schedulerQueue = new Queue('dial-scheduler', { connection })
const callQueue      = new Queue('dial-calls',     { connection })

// Prevent unhandled 'error' events from crashing the Node.js process.
// Log only the first error per queue — retryStrategy handles reconnection silently.
let _schedulerErrLogged = false, _callsErrLogged = false
schedulerQueue.on('error', (err) => {
  if (!_schedulerErrLogged) { console.error('[dialQueue/scheduler] Redis unavailable:', err.message); _schedulerErrLogged = true }
})
callQueue.on('error', (err) => {
  if (!_callsErrLogged) { console.error('[dialQueue/calls] Redis unavailable:', err.message); _callsErrLogged = true }
})

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

    // Respect exhaustion: if attempts already at max, mark EXHAUSTED not NO_ANSWER
    const lead = await prisma.lead.findUnique({
      where: { id: call.leadId },
      select: { callAttempts: true, campaign: { select: { maxAttempts: true } } }
    }).catch(() => null)
    const terminalStatus = (lead && lead.callAttempts >= (lead.campaign?.maxAttempts ?? Infinity))
      ? 'EXHAUSTED'
      : 'NO_ANSWER'

    await prisma.lead.update({
      where: { id: call.leadId },
      data: { status: terminalStatus }
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

      // Atomic optimistic lock: only set CALLING if not already CALLING.
      // Prevents the same lead being double-queued when two runScheduler calls
      // run concurrently (e.g. recurring scan + manual triggerCampaign overlap).
      const grabbed = await prisma.lead.updateMany({
        where: { id: lead.id, status: { not: 'CALLING' } },
        data: { status: 'CALLING' }
      })
      if (grabbed.count === 0) continue

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
        attempts: 1,      // No BullMQ auto-retry: if the job throws after vapiService.startOutboundCall
        timeout: 45000    // succeeds, a retry would make a second real phone call. Scheduler handles retries.
      })
    }
  }
}

async function drainCampaignJobs(campaignId) {
  try {
    const [waiting, delayed] = await Promise.all([
      callQueue.getWaiting(),
      callQueue.getDelayed()
    ])
    const jobs = [...waiting, ...delayed].filter(j => j.data?.campaignId === campaignId)
    await Promise.all(jobs.map(j => j.remove()))
    if (jobs.length > 0) {
      console.log(`[dialQueue] Drained ${jobs.length} queued job(s) for campaign ${campaignId}`)
    }
  } catch (err) {
    console.error(`[dialQueue] Failed to drain jobs for campaign ${campaignId}:`, err.message)
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

  // Guard: re-fetch live state before every call — catches pause/company-pause
  // that happened after this job was already queued.
  const liveState = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, tenant: { select: { status: true } } }
  })
  if (liveState?.status !== 'ACTIVE') {
    console.log(`[dialQueue] Campaign ${campaignId} is ${liveState?.status} — skipping lead ${leadId}, resetting to PENDING`)
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'PENDING' } }).catch(() => {})
    return
  }
  if (liveState?.tenant?.status !== 'ACTIVE') {
    console.log(`[dialQueue] Tenant is ${liveState.tenant.status} (company paused from admin) — skipping lead ${leadId}, resetting to PENDING`)
    await prisma.lead.update({ where: { id: leadId }, data: { status: 'PENDING' } }).catch(() => {})
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
      select: {
        timezone: true,
        script: { select: { compiledPrompt: true, language: true, agentGender: true } }
      }
    })
    scriptLanguage = campaign?.script?.language || 'en'
    scriptGender   = campaign?.script?.agentGender || 'female'

    const meta = JSON.parse(campaign?.script?.compiledPrompt || '{}')
    const basePrompt = meta.prompt || ''

    if (basePrompt) {
      // Inject today's date in the campaign's timezone so the AI generates correct
      // future dates. Without this, GPT uses its 2024 training-cutoff as "today"
      // and books meetings in the past.
      const campaignTz = campaign?.timezone || 'UTC'
      const todayStr = new Date().toLocaleDateString('en-US', {
        timeZone: campaignTz,
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })
      const dateBlock = `TODAY: ${todayStr} (${campaignTz}). All meetings and callbacks MUST be scheduled for future dates only.\n\n`

      if (priorCalls.length > 0) {
        const historyLines = priorCalls.map((c, i) => {
          const date = c.endedAt
            ? c.endedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : 'unknown date'
          return `Call ${i + 1} (${date}): ${c.summary}`
        }).join('\n')

        const contextBlock = `PRIOR CALL HISTORY — READ BEFORE STARTING\nYou have called this person before:\n${historyLines}\nOpen by acknowledging you've spoken: "We spoke previously — just wanted to follow up."\nReference what was discussed. Don't repeat the same pitch.\n\n`
        systemPromptOverride = dateBlock + contextBlock + basePrompt
        console.log(`[dialQueue] Lead ${leadId} — injecting date (${todayStr}) + ${priorCalls.length} prior call(s) into prompt`)
      } else {
        systemPromptOverride = dateBlock + basePrompt
        console.log(`[dialQueue] Lead ${leadId} — injecting date (${todayStr}) into prompt`)
      }
    }
  } catch (err) {
    console.error(`[dialQueue] Could not build call history / fetch script language for lead ${leadId}:`, err.message)
  }

  let vapiCall
  try {
    vapiCall = await vapiService.startOutboundCall({
      toNumber, vapiNumberId, vapiAssistantId,
      voiceOverrideId: clonedVoiceId || undefined,
      systemPromptOverride,
      language: scriptLanguage,
      agentGender: scriptGender,
      metadata: { tenantId, leadId, campaignId, callRecordId: callRecord.id, leadName, leadCompany, leadTitle }
    })
  } catch (err) {
    const is400 = err.response?.status === 400
    const msg   = JSON.stringify(err.response?.data?.message || '')
    if (is400 && (msg.toLowerCase().includes('e.164') || msg.toLowerCase().includes('phone number'))) {
      console.warn(`[dialQueue] Lead ${leadId} has invalid phone (${toNumber}) — marked WRONG_NUMBER, will not retry`)
      await prisma.lead.update({ where: { id: leadId }, data: { status: 'WRONG_NUMBER' } }).catch(() => {})
      await prisma.call.update({ where: { id: callRecord.id }, data: { status: 'COMPLETED', outcome: 'NO_ANSWER', endedAt: new Date() } }).catch(() => {})
      return
    }
    throw err
  }

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
      // Set NO_ANSWER (not PENDING) so the retryAfterHours gate applies before the
      // scheduler picks this lead up again. Setting PENDING would cause an immediate
      // re-queue on the next 5-min scan, bypassing the wait window entirely.
      await prisma.lead.update({
        where: { id: job.data.leadId },
        data: { status: 'NO_ANSWER' }
      }).catch(() => {})
    }
  })

  let _swErrLogged = false, _cwErrLogged = false
  schedulerWorker.on('error', (err) => { if (!_swErrLogged) { console.error('[dialQueue/schedulerWorker] Redis unavailable:', err.message); _swErrLogged = true } })
  callWorker.on('error',      (err) => { if (!_cwErrLogged) { console.error('[dialQueue/callWorker] Redis unavailable:',      err.message); _cwErrLogged = true } })

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

module.exports = { startWorker, triggerCampaign, stopWorker, drainCampaignJobs }
