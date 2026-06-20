// backend/src/routes/webhooks.js
// ============================================================
// FIX-08 — webhooks.js (Pankaj review, June 19/20)
// ROOT CAUSES FOUND & FIXED:
//
//   BUG-A (duration not shown):
//     handleCallEnded() trusted call.startedAt OR callRecord.startedAt
//     with no validation. If both were missing/garbage, durationSeconds
//     silently became 0 — and the frontend formatDuration() treats 0 as
//     "no data" (renders "—"), making it LOOK like nothing was tracked.
//     FIXED: durationSeconds now has 3 fallback layers + is NEVER left
//     as a silent 0 when we have ANY usable timestamp. Also logs loudly
//     if duration could not be computed at all, so it's visible in logs
//     instead of failing silently.
//
//   BUG-B (calls not storing — webhook auth gap):
//     verifyVapiSignature() ONLY checked the legacy `x-vapi-secret`
//     header. Vapi's credential-based auth (the newer/recommended setup)
//     sends `X-Vapi-Signature` (HMAC-SHA256) instead. If your Vapi
//     assistant/org is using a Credential instead of the inline `secret`
//     field, x-vapi-secret arrives EMPTY and every webhook was silently
//     401'd — meaning the call event never reached this code, so nothing
//     was ever written to the database. This is almost certainly why
//     calls appeared to "not store."
//     FIXED: now accepts EITHER header. Also logs an unmistakable,
//     repeated console.error if auth keeps failing, instead of one
//     quiet console.warn buried in normal traffic.
//
//   BUG-C (startedAt race):
//     dialQueue.js sets startedAt at DIAL time (status: RINGING).
//     webhooks.js OVERWRITES it at ANSWER time (status: IN_PROGRESS)
//     — but only if the 'call-started'/'status-update' event arrives
//     AND event.status is exactly 'in-progress'. If Vapi sends a
//     different status string, startedAt silently stays at dial-time,
//     so duration includes ring time. FIXED: broadened the status match
//     and added a fallback so handleCallEnded can detect "this looks
//     like dial-time, not answer-time" using the artifact's own
//     timestamps when available.
//
// ALL prior fixes preserved: BUG-3, BUG-4, BUG-5 (meeting booking),
// sentimentLog handling.
// ============================================================

const router = require('express').Router()
const crypto = require('crypto')
const prisma = require('../lib/prisma')
const calendarService = require('../services/calendar')
const crmService      = require('../services/crm')
const billingService  = require('../services/billing')

// ── Auth: supports BOTH Vapi auth styles ───────────────────────────────────────
// 1. Legacy inline `secret` field → arrives as `x-vapi-secret` header (plain match)
// 2. Credential-based auth (newer, recommended by Vapi) → arrives as
//    `x-vapi-signature` header, HMAC-SHA256 of the raw body using the secret
function verifyVapiRequest(req, rawBodyStr) {
  const secret = process.env.VAPI_WEBHOOK_SECRET
  if (!secret) return { ok: true, method: 'none (no secret configured)' }

  // Method 1: legacy plain secret header
  const plainSecret = req.headers['x-vapi-secret']
  if (plainSecret) {
    try {
      const a = Buffer.from(plainSecret)
      const b = Buffer.from(secret)
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { ok: true, method: 'x-vapi-secret' }
      }
    } catch { /* fall through to try signature method */ }
  }

  // Method 2: HMAC signature header (credential-based auth)
  const signature = req.headers['x-vapi-signature']
  if (signature) {
    try {
      const expected = crypto.createHmac('sha256', secret).update(rawBodyStr).digest('hex')
      const a = Buffer.from(signature)
      const b = Buffer.from(expected)
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { ok: true, method: 'x-vapi-signature (hmac)' }
      }
    } catch { /* fall through to reject */ }
  }

  return {
    ok: false,
    method: plainSecret
      ? 'x-vapi-secret (mismatch)'
      : (signature ? 'x-vapi-signature (mismatch)' : 'no auth header present')
  }
}

let consecutiveAuthFailures = 0

router.post('/vapi', async (req, res) => {
  const bodyStr = req.body.toString()

  const authResult = verifyVapiRequest(req, bodyStr)
  if (!authResult.ok) {
    consecutiveAuthFailures++
    // LOUD logging — this used to be a single console.warn easy to miss.
    // If you see this in logs, your VAPI_WEBHOOK_SECRET does not match
    // what's configured in the Vapi dashboard/assistant — fix that first,
    // every call's data is being silently dropped until this is resolved.
    console.error('========================================')
    console.error(`[webhook/vapi] AUTH REJECTED (#${consecutiveAuthFailures} in a row) — reason: ${authResult.method}`)
    console.error(`[webhook/vapi] Headers received: x-vapi-secret="${req.headers['x-vapi-secret'] ? '[present]' : '[absent]'}" x-vapi-signature="${req.headers['x-vapi-signature'] ? '[present]' : '[absent]'}"`)
    console.error(`[webhook/vapi] Fix: go to Vapi Dashboard → your assistant → Server URL Secret and make sure VAPI_WEBHOOK_SECRET in .env matches exactly.`)
    console.error('========================================')
    return res.status(401).json({ error: 'Invalid webhook signature' })
  }

  consecutiveAuthFailures = 0

  let event, type, call
  try {
    const raw = JSON.parse(bodyStr)
    event = raw.message || raw
    type  = event.type
    call  = event.call
    console.log('[webhook/vapi] TYPE:', type, '| CALL ID:', call?.id || '')
  } catch (parseErr) {
    console.error('[webhook/vapi] Body parse error:', parseErr.message)
    return res.status(200).json({ received: true })
  }

  // tool-calls MUST be handled synchronously — Vapi waits for { results: [...] }
  if (type === 'tool-calls') {
    try {
      if (!call?.id) return res.status(200).json({ results: [] })
      const results = await handleToolCalls(event)
      return res.status(200).json({ results })
    } catch (err) {
      console.error('[webhook/vapi] tool-calls error:', err.message)
      return res.status(200).json({ results: [] })
    }
  }

  // All other events: respond immediately, process in background
  res.status(200).json({ received: true })

  if (!call?.id) return

  try {
    switch (type) {
      case 'call-started':
      case 'status-update':
        // FIX BUG-C: broadened match — Vapi can send 'in-progress' or 'in_progress'
        if (type === 'call-started' || event.status === 'in-progress' || event.status === 'in_progress') {
          await handleCallStarted(call)
        }
        break
      case 'end-of-call-report':
      case 'call-ended':
        await handleCallEnded(event)
        break
      case 'function-call':
        await handleFunctionCall(event)
        break
      case 'transcript':
        await handleTranscriptUpdate(call)
        break
      default:
        console.log('[webhook/vapi] unhandled type:', type, JSON.stringify(event).slice(0, 200))
    }
  } catch (err) {
    console.error('[webhook/vapi] Error processing event:', err.message, err.stack)
  }
})

async function handleCallStarted(call) {
  await prisma.call.updateMany({
    where: { vapiCallId: call.id },
    data: { status: 'IN_PROGRESS', startedAt: new Date() }
  })
  const callRecord = await prisma.call.findFirst({ where: { vapiCallId: call.id } })
  if (callRecord) {
    await prisma.lead.update({
      where: { id: callRecord.leadId },
      data: { status: 'CALLING' }
    })
  }
}

async function handleCallEnded(event) {
  const call        = event.call || event
  const artifact    = event.artifact || call.artifact || {}
  const analysis    = event.analysis || call.analysis || {}
  const endedReason = event.endedReason || call.endedReason

  const callRecord = await prisma.call.findFirst({
    where: { vapiCallId: call.id },
    include: { tenant: true, lead: true }
  })
  if (!callRecord) return

  // FIX BUG-A: 3-layer fallback for duration calculation with loud logging
  // Layer 1: use Vapi's own artifact timestamps (most accurate — actual answer time)
  // Layer 2: use Vapi call object timestamps
  // Layer 3: use our DB record's startedAt (dial time, includes ring — worst case)
  const endedAt = call.endedAt ? new Date(call.endedAt) : new Date()

  let durationSeconds = 0
  let durationSource  = 'unknown'

  const artifactStartedAt = artifact.startedAt ? new Date(artifact.startedAt) : null
  const callStartedAt     = call.startedAt     ? new Date(call.startedAt)     : null
  const recordStartedAt   = callRecord.startedAt

  if (artifactStartedAt && !isNaN(artifactStartedAt)) {
    durationSeconds = Math.max(0, Math.floor((endedAt - artifactStartedAt) / 1000))
    durationSource  = 'artifact.startedAt'
  } else if (callStartedAt && !isNaN(callStartedAt)) {
    durationSeconds = Math.max(0, Math.floor((endedAt - callStartedAt) / 1000))
    durationSource  = 'call.startedAt'
  } else if (recordStartedAt) {
    durationSeconds = Math.max(0, Math.floor((endedAt - recordStartedAt) / 1000))
    durationSource  = 'db.startedAt (dial-time fallback — includes ring)'
    console.warn(`[webhook] handleCallEnded — vapiId=${call.id}: falling back to dial-time startedAt, duration may include ring time`)
  } else {
    durationSeconds = 0
    durationSource  = 'none — could not compute'
    console.error(`[webhook] handleCallEnded — vapiId=${call.id}: NO startedAt available anywhere, durationSeconds=0`)
  }

  console.log(`[webhook] handleCallEnded — vapiId=${call.id} endedReason=${endedReason} duration=${durationSeconds}s source:${durationSource}`)

  const mappedOutcome = mapVapiEndReason(endedReason) || 'NO_ANSWER'
  // Prefer outcome already written by AI tool-calls during the call.
  // meetingBookedAt is the authoritative booking signal; callRecord.outcome
  // may already be CALLBACK or NOT_INTERESTED from scheduleCallback / markNotInterested.
  const outcome = callRecord.meetingBookedAt
    ? 'BOOKED'
    : (callRecord.outcome || mappedOutcome)

  const transcript   = formatTranscript(artifact.transcript) || formatTranscript(artifact.messages)
  const summary      = analysis.summary || null
  const recordingUrl = artifact.recordingUrl || null

  const billedMinutes = Math.ceil(durationSeconds / 6) / 10
  const billedAmount  = billedMinutes * callRecord.tenant.ratePerMinute

  await prisma.call.update({
    where: { id: callRecord.id },
    data: {
      status: 'COMPLETED',
      outcome, durationSeconds, transcript, summary, recordingUrl,
      billedMinutes, billedAmount,
      endedAt: new Date()
    }
  })

  await prisma.lead.update({
    where: { id: callRecord.leadId },
    data: { status: outcomeToLeadStatus(outcome) }
  })

  if (billedMinutes > 0) {
    await billingService.recordUsage(callRecord.tenantId, billedMinutes, billedAmount).catch(err =>
      console.error('[webhook] billing record failed:', err.message)
    )
  }

  // Sentiment log — stored as JSON on the Call record (not a separate table)
  try {
    const sentimentLog = analysis.sentimentLog || analysis.sentiment_log
    if (sentimentLog && Array.isArray(sentimentLog) && sentimentLog.length > 0) {
      await prisma.call.update({
        where: { id: callRecord.id },
        data: { sentimentLog }
      })
    }
  } catch (err) {
    console.error('[webhook] sentimentLog store error:', err.message)
  }

  // Meeting booking (BUG-3, BUG-4, BUG-5 fixes preserved)
  if (outcome === 'BOOKED' && !callRecord.meetingBookedAt) {
    await processMeetingBooking(callRecord, analysis).catch(err =>
      console.error('[webhook] meeting booking failed:', err.message)
    )
  }

  if (outcome !== 'BOOKED') {
    await crmService.syncContact(callRecord.tenantId, callRecord.leadId, outcome).catch(err =>
      console.error('[webhook] CRM sync failed:', err.message)
    )
  }
}

async function processMeetingBooking(callRecord, analysis) {
  const scheduledTime = analysis.scheduledTime || analysis.meetingTime || analysis.bookingTime
  if (!scheduledTime) return

  const campaign = await prisma.campaign.findUnique({
    where: { id: callRecord.campaignId },
    select: { timezone: true }
  })

  try {
    const meeting = await calendarService.bookMeeting({
      tenant:        callRecord.tenant,
      prospectName:  callRecord.lead?.name  || '',
      prospectEmail: callRecord.lead?.email || null,
      preferredSlot: scheduledTime,
      timezone:      campaign?.timezone || 'UTC'
    })

    await prisma.call.update({
      where: { id: callRecord.id },
      data: {
        scheduledMeetingAt: new Date(scheduledTime),
        meetingBookedAt: new Date(),
        meetingLink: meeting?.meetingUrl || null
      }
    })

    await prisma.lead.update({
      where: { id: callRecord.leadId },
      data: { status: 'BOOKED', meetingBookedAt: new Date(), meetingLink: meeting?.meetingUrl || null }
    })

    await crmService.syncContact(callRecord.tenantId, callRecord.leadId, 'BOOKED').catch(() => {})

    console.log(`[webhook] Meeting booked for lead ${callRecord.leadId} at ${scheduledTime}`)
  } catch (err) {
    // BUG-3 fix: was incorrectly setting outcome BOOKED on failure
    // BUG-4 fix: log full Cal.com error detail
    console.error('[webhook] Cal.com booking failed:', err.response?.data || err.message)
    await prisma.call.update({
      where: { id: callRecord.id },
      data: { outcome: 'CALLBACK' }
    })
    await prisma.lead.update({
      where: { id: callRecord.leadId },
      data: { status: 'CALLBACK' }
    })
  }
}

async function handleTranscriptUpdate(call) {
  const callRecord = await prisma.call.findFirst({ where: { vapiCallId: call.id } })
  if (!callRecord) return
  const transcript = formatTranscript(call.transcript) || formatTranscript(call.messages)
  if (transcript) {
    await prisma.call.update({ where: { id: callRecord.id }, data: { transcript } })
  }
}

async function handleToolCalls(event) {
  const toolCalls = event.toolCallList || event.toolCalls || []
  const results   = []

  for (const toolCall of toolCalls) {
    const name = toolCall.function?.name || toolCall.name
    const args = toolCall.function?.arguments || toolCall.arguments || {}
    const id   = toolCall.id

    try {
      let result
      if (name === 'bookMeeting') {
        const call       = event.call
        const callRecord = await prisma.call.findFirst({
          where: { vapiCallId: call?.id },
          include: { tenant: true, lead: true }
        })

        if (!callRecord) {
          result = 'Error: call record not found'
        } else {
          const campaign = await prisma.campaign.findUnique({
            where: { id: callRecord.campaignId },
            select: { timezone: true }
          })
          const meetingTime = args.datetime ? new Date(args.datetime) : null

          // Record the booking intent NOW — before attempting Cal.com.
          // This ensures outcome=BOOKED and scheduledMeetingAt are stored
          // even if the external Cal.com call fails (so the AI can still
          // say "confirmed" and the Meetings page shows the entry).
          await prisma.call.update({
            where: { id: callRecord.id },
            data: { scheduledMeetingAt: meetingTime, meetingBookedAt: new Date(), outcome: 'BOOKED' }
          })
          await prisma.lead.update({
            where: { id: callRecord.leadId },
            data: { status: 'BOOKED', meetingBookedAt: new Date() }
          })

          // Now try to create the Cal.com booking — failure is non-fatal.
          // If it fails, the booking intent is already stored; admin can
          // manually confirm. We do NOT throw here so the AI gets "confirmed".
          try {
            const meeting = await calendarService.bookMeeting({
              tenant:        callRecord.tenant,
              prospectName:  callRecord.lead?.name  || '',
              prospectEmail: callRecord.lead?.email || null,
              preferredSlot: args.datetime,
              timezone:      campaign?.timezone || 'UTC'
            })
            if (meeting?.meetingUrl) {
              await prisma.call.update({ where: { id: callRecord.id }, data: { meetingLink: meeting.meetingUrl } })
              await prisma.lead.update({ where: { id: callRecord.leadId }, data: { meetingLink: meeting.meetingUrl } })
            }
          } catch (calErr) {
            console.error('[webhook] Cal.com booking failed — intent already stored, manual follow-up needed:', calErr.message)
          }

          result = `Meeting confirmed for ${args.datetime || 'the requested time'}. Confirmation details will be sent shortly.`
        }
      } else if (name === 'scheduleCallback') {
        const call       = event.call
        const callRecord = await prisma.call.findFirst({ where: { vapiCallId: call?.id } })
        if (callRecord) {
          await prisma.call.update({
            where: { id: callRecord.id },
            data: { outcome: 'CALLBACK' }
          })
          await prisma.lead.update({
            where: { id: callRecord.leadId },
            data: { status: 'CALLBACK', callbackAt: args.datetime ? new Date(args.datetime) : null }
          })
        }
        result = `Callback scheduled${args.datetime ? ` for ${args.datetime}` : ''}`
      } else if (name === 'markNotInterested') {
        const call       = event.call
        const callRecord = await prisma.call.findFirst({ where: { vapiCallId: call?.id } })
        if (callRecord) {
          await prisma.call.update({
            where: { id: callRecord.id },
            data: { outcome: 'NOT_INTERESTED' }
          })
          await prisma.lead.update({
            where: { id: callRecord.leadId },
            data: { status: 'NOT_INTERESTED' }
          })
        }
        result = 'Marked as not interested'
      } else {
        result = `Unknown function: ${name}`
      }
      results.push({ toolCallId: id, result: String(result) })
    } catch (err) {
      console.error(`[webhook] tool-call "${name}" failed:`, err.message)
      results.push({ toolCallId: id, result: `Error: ${err.message}` })
    }
  }

  return results
}

async function handleFunctionCall(event) {
  // Legacy Vapi function-call format (pre-tool-calls)
  const fn   = event.functionCall || {}
  const name = fn.name
  const args = fn.parameters || fn.arguments || {}

  if (!name) return

  const call       = event.call
  const callRecord = await prisma.call.findFirst({ where: { vapiCallId: call?.id } })
  if (!callRecord) return

  try {
    if (name === 'bookMeeting') {
      await prisma.call.update({
        where: { id: callRecord.id },
        data: { scheduledMeetingAt: args.datetime ? new Date(args.datetime) : null, outcome: 'BOOKED' }
      })
      await prisma.lead.update({
        where: { id: callRecord.leadId },
        data: { status: 'BOOKED' }
      })
    } else if (name === 'scheduleCallback') {
      await prisma.call.update({
        where: { id: callRecord.id },
        data: { outcome: 'CALLBACK' }
      })
      await prisma.lead.update({
        where: { id: callRecord.leadId },
        data: { status: 'CALLBACK', callbackAt: args.datetime ? new Date(args.datetime) : null }
      })
    }
  } catch (err) {
    console.error(`[webhook] function-call "${name}" failed:`, err.message)
  }
}

function mapVapiEndReason(reason) {
  if (!reason) return null
  const r = reason.toLowerCase()
  if (r.includes('customer-did-not-answer') || r.includes('no-answer')) return 'NO_ANSWER'
  if (r.includes('voicemail'))        return 'VOICEMAIL'
  // customer-ended / assistant-ended = normal conversation finish.
  // Return null so the AI's tool-call outcome (CALLBACK, NOT_INTERESTED, etc.) is preserved.
  // Falls back to NO_ANSWER via the `|| 'NO_ANSWER'` in the caller.
  if (r.includes('customer-ended'))   return null
  if (r.includes('assistant-ended'))  return null
  if (r.includes('error'))            return 'ERROR'   // was 'FAILED' — not a valid CallOutcome
  return null
}

function outcomeToLeadStatus(outcome) {
  const map = {
    BOOKED:         'BOOKED',
    CALLBACK:       'CALLBACK',
    NOT_INTERESTED: 'NOT_INTERESTED',
    VOICEMAIL:      'VOICEMAIL',
    NO_ANSWER:      'NO_ANSWER',
    ERROR:          'NO_ANSWER'
  }
  return map[outcome] || 'NO_ANSWER'
}

function formatTranscript(input) {
  if (!input) return null
  if (typeof input === 'string') return input
  if (Array.isArray(input)) {
    return input
      .map(m => {
        const role = (m.role || m.speaker || 'unknown').toUpperCase()
        const text = m.content || m.message || m.text || ''
        return `[${role}] ${text}`
      })
      .filter(l => l.trim().length > 10)
      .join('\n')
  }
  return null
}

module.exports = router
