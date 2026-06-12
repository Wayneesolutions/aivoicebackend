// backend/src/workers/dialQueue.js
// Bull-backed dial queue — replaces the fragile setInterval approach.
// Jobs survive server restarts. Concurrency is enforced by Bull, not in-memory counters.
const { Queue, Worker, QueueScheduler } = require('bullmq')
const { PrismaClient } = require('@prisma/client')
const { parsePhoneNumberFromString } = require('libphonenumber-js')
const vapiService = require('../services/vapi')

const prisma = new PrismaClient()

const REDIS_URL   = process.env.REDIS_URL || 'redis://localhost:6379'
const MAX_CONCURRENT = 10

// Parse Redis URL into connection config for BullMQ
function redisConnection() {
  try {
    const url = new URL(REDIS_URL)
    const conn = {
      host:     url.hostname,
      port:     parseInt(url.port) || 6379,
      password: url.password || undefined,
      tls:      url.protocol === 'rediss:' ? {} : undefined
    }
    return conn
  } catch {
    return { host: 'localhost', port: 6379 }
  }
}

const connection = redisConnection()

// Two queues:
//   dial-scheduler  — a single repeatable job that scans campaigns every 5 min
//   dial-calls      — one job per individual outbound call, concurrency = MAX_CONCURRENT
const schedulerQueue = new Queue('dial-scheduler', { connection })
const callQueue      = new Queue('dial-calls',     { connection })

// ── SCHEDULER WORKER ─────────────────────────────────────────────────────────
// Runs every 5 min, finds leads ready to be called, enqueues one dial-calls job per lead

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
      const inTz = new Date(now.toLocaleString('en-US', { timeZone: campaign.timezone }))
      console.log(`[dialQueue] Campaign "${campaign.name}" — outside calling hours (${inTz.getHours()}:${String(inTz.getMinutes()).padStart(2,'0')} ${campaign.timezone}, window ${campaign.callFromHour}–${campaign.callToHour}), skipping`)
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

    console.log(`[dialQueue] Campaign "${campaign.name}" — ${leads.length} lead(s) eligible to dial`)

    for (const lead of leads) {
      const phoneRecord = pickNumberForLead(campaign.tenant.phoneNumbers, lead.country)
      if (!phoneRecord) {
        console.warn(`[dialQueue] No number for country ${lead.country} — tenant ${campaign.tenantId}`)
        continue
      }
      if (!phoneRecord.vapiNumberId) {
        console.warn(`[dialQueue] Phone number ${phoneRecord.number} has no vapiNumberId — assign it in Admin → Phone Numbers`)
        continue
      }

      // Mark CALLING before enqueuing so the next scheduler tick skips it
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
        leadName:        lead.name,
        leadCompany:     lead.company || '',
        leadTitle:       lead.title   || ''
      }, {
        attempts: 2,                  // retry once on transient Vapi errors
        backoff: { type: 'fixed', delay: 10000 }
      })
    }
  }
}

// ── CALL WORKER ──────────────────────────────────────────────────────────────
// Processes one outbound call per job. concurrency = MAX_CONCURRENT means Bull
// runs at most 10 of these in parallel across all server instances.

async function dialLead(job) {
  const { leadId, campaignId, tenantId, toNumber, fromNumberId, vapiNumberId, vapiAssistantId, leadName, leadCompany, leadTitle } = job.data

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
    toNumber, vapiNumberId, vapiAssistantId,
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
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

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

// ── STARTUP ──────────────────────────────────────────────────────────────────

let schedulerWorker = null
let callWorker = null

async function startWorker() {
  // Repeatable scheduler job — upserts so restarts don't duplicate it
  await schedulerQueue.add(
    'scan-campaigns',
    {},
    { repeat: { every: 5 * 60 * 1000 }, jobId: 'recurring-scan' }
  )

  schedulerWorker = new Worker('dial-scheduler', async () => {
    await runScheduler()
  }, { connection })

  callWorker = new Worker('dial-calls', dialLead, {
    connection,
    concurrency: MAX_CONCURRENT
  })

  callWorker.on('failed', async (job, err) => {
    console.error(`[dialQueue] Job ${job?.id} failed:`, err.message)
    if (job?.data?.leadId) {
      await prisma.lead.update({
        where: { id: job.data.leadId },
        data: { status: 'PENDING' }
      }).catch(() => {})
    }
  })

  console.log('[dialQueue] Bull workers started (scheduler every 5 min, concurrency', MAX_CONCURRENT, ')')
}

// Trigger a specific campaign immediately (called when client clicks Start Campaign)
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
