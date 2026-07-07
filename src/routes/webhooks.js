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

  // Compliance override: scan transcript for explicit removal/opt-out language.
  // Runs AFTER the AI tool-call outcome is set, so it catches cases where the AI
  // called markNotInterested instead of end_call(OPTED_OUT) for a removal request.
  const finalOutcome = outcome !== 'BOOKED' ? detectOptOut(transcript, summary, outcome, durationSeconds) : outcome

  const billedMinutes = Math.ceil(durationSeconds / 6) / 10
  const billedAmount  = billedMinutes * callRecord.tenant.ratePerMinute

  await prisma.call.update({
    where: { id: callRecord.id },
    data: {
      status: 'COMPLETED',
      outcome: finalOutcome, durationSeconds, transcript, summary, recordingUrl,
      billedMinutes, billedAmount,
      endedAt: new Date()
    }
  })

  const leadStatusData = { status: outcomeToLeadStatus(finalOutcome) }
  if (finalOutcome === 'OPTED_OUT') {
    leadStatusData.isOptedOut = true
    leadStatusData.optedOutAt = new Date()
  }

  await prisma.lead.update({
    where: { id: callRecord.leadId },
    data: leadStatusData
  })

  if (billedMinutes > 0) {
    await billingService.logUsage({
      tenantId:      callRecord.tenantId,
      callId:        callRecord.id,
      minutes:       billedMinutes,
      ratePerMinute: callRecord.tenant.ratePerMinute,
      amount:        billedAmount
    }).catch(err =>
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

  if (finalOutcome !== 'BOOKED') {
    await crmService.syncContact(callRecord.tenantId, callRecord.leadId, finalOutcome).catch(err =>
      console.error('[webhook] CRM sync failed:', err.message)
    )
  }

  // WhatsApp bridge: if the lead clearly agreed (BOOKED), automatically add them
  // to the WhatsApp opted-in list so they appear in the WhatsApp outreach section.
  // Runs fire-and-forget — never blocks or risks the main call-end flow.
  if (outcome === 'BOOKED') {
    bridgeLeadToWhatsApp(callRecord, recordingUrl).catch(err =>
      console.error('[webhook] WA bridge failed:', err.message)
    )
  }
}

// Per-tenant system list name — all leads who opt in via VoCallM calls land here.
const WA_AUTO_LIST_NAME = 'VoCallM Opted-In'

async function bridgeLeadToWhatsApp(callRecord, recordingUrl) {
  const lead     = callRecord.lead
  const tenantId = callRecord.tenantId

  if (!lead?.phone) return

  // Find or create the auto-managed list for this tenant (one list per tenant, created lazily)
  let list = await prisma.waContactList.findFirst({
    where: { tenantId, name: WA_AUTO_LIST_NAME },
  })
  if (!list) {
    list = await prisma.waContactList.create({
      data: { tenantId, name: WA_AUTO_LIST_NAME, totalContacts: 0 },
    })
  }

  // Check if this phone is already in the list
  const existing = await prisma.waContact.findFirst({
    where: { contactListId: list.id, phone: lead.phone },
  })

  if (existing) {
    // Only upgrade status — never downgrade an already OPTED_IN contact
    if (existing.optInStatus !== 'OPTED_IN') {
      await prisma.waContact.update({
        where: { id: existing.id },
        data: {
          fullName:          lead.name         || existing.fullName,
          businessName:      lead.company      || existing.businessName,
          optInStatus:       'OPTED_IN',
          optInSource:       'vocallm_call',
          optInTimestamp:    new Date(),
          optInCallId:       callRecord.vapiCallId || callRecord.id,
          optInRecordingUrl: recordingUrl || null,
        },
      })
      console.log(`[webhook] WA bridge: upgraded ${lead.phone} → OPTED_IN`)
    }
    return
  }

  // New contact — insert and increment list counter atomically
  await prisma.$transaction([
    prisma.waContact.create({
      data: {
        contactListId:     list.id,
        tenantId,
        phone:             lead.phone,
        fullName:          lead.name    || null,
        businessName:      lead.company || null,
        optInStatus:       'OPTED_IN',
        optInSource:       'vocallm_call',
        optInTimestamp:    new Date(),
        optInCallId:       callRecord.vapiCallId || callRecord.id,
        optInRecordingUrl: recordingUrl || null,
      },
    }),
    prisma.waContactList.update({
      where: { id: list.id },
      data:  { totalContacts: { increment: 1 } },
    }),
  ])

  console.log(`[webhook] WA bridge: added ${lead.phone} (${lead.name}) → OPTED_IN in list "${WA_AUTO_LIST_NAME}"`)
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
      // book_meeting = snake_case name from script.js tool definitions
      // bookMeeting  = legacy camelCase — keep both so old assistants still work
      if (name === 'bookMeeting' || name === 'book_meeting') {
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
          // book_meeting passes preferred_slot; legacy bookMeeting passed datetime
          const slotRaw   = args.preferred_slot || args.datetime || null
          const meetingTime = slotRaw ? new Date(slotRaw) : null
          // book_meeting can pass prospect_email directly from what the agent collected
          const prospectEmail = args.prospect_email || callRecord.lead?.email || null

          await prisma.call.update({
            where: { id: callRecord.id },
            data: { scheduledMeetingAt: meetingTime, meetingBookedAt: new Date(), outcome: 'BOOKED' }
          })
          await prisma.lead.update({
            where: { id: callRecord.leadId },
            data: { status: 'BOOKED', meetingBookedAt: new Date() }
          })

          try {
            const meeting = await calendarService.bookMeeting({
              tenant:        callRecord.tenant,
              prospectName:  args.prospect_name || callRecord.lead?.name || '',
              prospectEmail,
              preferredSlot: slotRaw,
              timezone:      campaign?.timezone || 'UTC'
            })
            if (meeting?.meetingUrl) {
              await prisma.call.update({ where: { id: callRecord.id }, data: { meetingLink: meeting.meetingUrl } })
              await prisma.lead.update({ where: { id: callRecord.leadId }, data: { meetingLink: meeting.meetingUrl } })
            }
          } catch (calErr) {
            console.error('[webhook] Cal.com booking failed — intent already stored, manual follow-up needed:', calErr.message)
          }

          result = `Meeting confirmed for ${slotRaw || 'the requested time'}. Confirmation details will be sent shortly.`
        }
      } else if (name === 'scheduleCallback' || name === 'request_callback') {
        const call       = event.call
        const callRecord = await prisma.call.findFirst({ where: { vapiCallId: call?.id } })
        // request_callback passes callback_time; legacy scheduleCallback passed datetime
        const callbackRaw = args.callback_time || args.datetime || null
        if (callRecord) {
          await prisma.call.update({
            where: { id: callRecord.id },
            data: { outcome: 'CALLBACK' }
          })
          await prisma.lead.update({
            where: { id: callRecord.leadId },
            data: { status: 'CALLBACK', callbackAt: callbackRaw ? new Date(callbackRaw) : null }
          })
        }
        result = `Callback scheduled${callbackRaw ? ` for ${callbackRaw}` : ''}`
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
      } else if (name === 'detect_sentiment') {
        // Store mid-call sentiment entry so the live dashboard updates in real time
        const call       = event.call
        const callRecord = await prisma.call.findFirst({ where: { vapiCallId: call?.id } })
        if (callRecord) {
          const existing = Array.isArray(callRecord.sentimentLog) ? callRecord.sentimentLog : []
          const entry = {
            t:                Date.now(),
            sentiment:        args.sentiment        || 'UNKNOWN',
            intent:           args.intent           || 'UNKNOWN',
            buying_signal:    args.buying_signal    || null,
            suggested_action: args.suggested_action || null
          }
          await prisma.call.update({
            where: { id: callRecord.id },
            data:  { sentimentLog: [...existing, entry] }
          })
        }
        result = 'ok'
      } else if (name === 'end_call' || name === 'endCall') {
        const call       = event.call
        const callRecord = await prisma.call.findFirst({ where: { vapiCallId: call?.id } })
        const reason     = (args.reason || '').toUpperCase()
        if (callRecord) {
          // Don't downgrade an outcome a more specific tool-call already set
          // (e.g. book_meeting already fired BOOKED before end_call hangs up).
          const alreadySet = callRecord.outcome && callRecord.outcome !== 'ERROR'
          if (!alreadySet && ['BOOKED','NOT_INTERESTED','CALLBACK','WRONG_NUMBER','OPTED_OUT','VOICEMAIL'].includes(reason)) {
            await prisma.call.update({
              where: { id: callRecord.id },
              data: { outcome: reason, summary: args.summary || undefined }
            })
            const leadData = { status: reason }
            if (reason === 'OPTED_OUT') {
              leadData.isOptedOut = true
              leadData.optedOutAt = new Date()
            }
            await prisma.lead.update({
              where: { id: callRecord.leadId },
              data: leadData
            })
          }
        }
        result = `Call ended — reason: ${reason || 'unspecified'}`
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

// Tier 1: Explicit DNC requests — unambiguous "remove me / stop calling" language
const OPT_OUT_PHRASES = [
  'remove me from your call list',
  'remove me from the call list',
  'remove me from your calling list',
  'take me off the calling list',
  'take me off your calling list',
  'take me off your call list',
  'take me off your list',
  'take me off the list',
  'remove me from your list',
  'please remove me',
  'stop calling me',
  'do not call me again',
  "don't call me again",
  'add me to your do not call',
  'put me on your do not call',
  'opt me out',
]

// Tier 2: Soft opt-out — rejection combined with a clear "don't call back / don't contact"
// signal. "We don't need services" alone is NOT_INTERESTED (may want services later).
// But pairing it with a permanence word ("don't call back", "ever", "anymore") makes it
// a real suppression request that must be honoured.
const SOFT_OPT_OUT_PHRASES = [
  // "don't call us" variants (main list covers "me"; these cover "us" / teams / businesses)
  "please don't call us anymore",
  "please don't call us again",
  "please don't call again",
  "please don't call back",
  "don't call us again",
  "don't call us back",
  "don't call us anymore",
  "never call us again",
  "never call me again",

  // "don't contact us"
  "please don't contact us",
  "don't contact us again",
  "do not contact us again",
  "do not contact us",
  "we don't want to be contacted",
  "we do not want to be contacted",

  // "please stop" broader forms (without explicit "me" — already covered above)
  "please stop calling",
  "please stop contacting",

  // Permanence rejection: "ever / anymore / never"
  "not interested now or ever",
  "not interested, ever",
  "we will never need your services",
  "we'll never need your services",
  "will never need your services",
  "we never want to hear from you",
  "we don't want any more calls",
  "we don't want any calls from you",
  "we don't want to receive calls",

  // Service rejection — clear "we have no need" statements
  "we don't need any services",
  "we don't need your services",
  "don't need any services",
  "don't need your services",
  "no need for your services",
  "not interested in any services",
  "we have no need for your services",
  "we don't require any services",
]

function detectOptOut(transcript, summary, currentOutcome, durationSeconds) {
  if (currentOutcome === 'OPTED_OUT' || currentOutcome === 'BOOKED') return currentOutcome
  // FIX (Jul 6): a call under 5s cannot contain a real opt-out request from the
  // customer -- guards against any residual prompt/instruction text still causing a
  // false match even after the formatTranscript system-role filter above.
  if (typeof durationSeconds === 'number' && durationSeconds < 5) return currentOutcome
  const text = ((transcript || '') + ' ' + (summary || '')).toLowerCase()

  const tier1 = OPT_OUT_PHRASES.find(phrase => text.includes(phrase))
  if (tier1) {
    console.log(`[webhook] detectOptOut: explicit opt-out phrase ("${tier1}") — overriding ${currentOutcome} → OPTED_OUT`)
    return 'OPTED_OUT'
  }

  const tier2 = SOFT_OPT_OUT_PHRASES.find(phrase => text.includes(phrase))
  if (tier2) {
    console.log(`[webhook] detectOptOut: soft opt-out phrase ("${tier2}") — overriding ${currentOutcome} → OPTED_OUT`)
    return 'OPTED_OUT'
  }

  return currentOutcome
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
    OPTED_OUT:      'OPTED_OUT',
    VOICEMAIL:      'VOICEMAIL',
    NO_ANSWER:      'NO_ANSWER',
    WRONG_NUMBER:   'WRONG_NUMBER',
    ERROR:          'NO_ANSWER'
  }
  return map[outcome] || 'NO_ANSWER'
}

function formatTranscript(input) {
  if (!input) return null
  if (typeof input === 'string') return input
  if (Array.isArray(input)) {
    return input
      // FIX (Jul 6): exclude system-role messages -- these are the instructional
      // prompt sent TO the AI (which necessarily contains example opt-out phrases like
      // "remove me" / "stop calling" so the AI knows how to recognize them). Including
      // them here made detectOptOut() below match against the AI's own instructions
      // instead of anything the customer actually said.
      .filter(m => (m.role || m.speaker || '').toLowerCase() !== 'system')
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

// ── Inbound Vapi Webhook (/api/webhooks/vapi-inbound) ─────────────────────────
// Receives assistant-request, call-started, end-of-call-report for inbound calls.
const inboundSummary      = require('../services/inboundSummary');
const inboundNotification = require('../services/inboundNotification');
const inboundVapi         = require('../services/inboundVapi');

router.post('/vapi-inbound', async (req, res) => {
  const bodyStr = req.body.toString();

  // Reuse same signature verification as outbound
  const authResult = verifyVapiRequest(req, bodyStr);
  if (!authResult.ok) {
    console.error('[webhook/vapi-inbound] AUTH REJECTED:', authResult.method);
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  let event, type;
  try {
    const raw = JSON.parse(bodyStr);
    event = raw.message || raw;
    type  = event.type;
  } catch {
    return res.status(200).json({ received: true });
  }

  console.log('[webhook/vapi-inbound] TYPE:', type);

  // Respond immediately — process async
  res.status(200).json({ received: true });

  try {
    switch (type) {

      // Vapi asks which assistant to use for this inbound number
      case 'assistant-request': {
        const calledNumber = event.call?.phoneNumberId || event.phoneNumber?.number;
        if (!calledNumber) break;

        const phone = await prisma.inboundPhoneNumber.findFirst({
          where: {
            OR: [{ phoneNumber: calledNumber }, { vapiPhoneId: calledNumber }],
            isActive: true,
            tenantId: { not: undefined },
          },
          include: {
            assistants: {
              where: { status: 'active' },
              orderBy: { updatedAt: 'desc' },
              take: 1,
            }
          }
        });

        if (!phone || !phone.assistants.length) {
          console.warn('[webhook/vapi-inbound] No active assistant for number:', calledNumber);
          break;
        }
        // Note: for assistant-request Vapi expects a synchronous response.
        // We already sent 200 above — Vapi will use the vapiAssistantId linked at activation time.
        break;
      }

      case 'call-started': {
        const call = event.call || {};
        const calledNumber = call.phoneNumberId || call.phoneNumber?.number;

        const phone = await prisma.inboundPhoneNumber.findFirst({
          where: { OR: [{ phoneNumber: calledNumber }, { vapiPhoneId: calledNumber }] },
          include: { assistants: { where: { status: 'active' }, take: 1 } }
        });

        if (phone && phone.assistants.length) {
          await prisma.inboundCall.upsert({
            where:  { vapiCallId: call.id || `missing-${Date.now()}` },
            create: {
              tenantId:     phone.tenantId,
              assistantId:  phone.assistants[0].id,
              phoneNumberId: phone.id,
              vapiCallId:   call.id,
              callerNumber: call.customer?.number,
              calledNumber,
              startedAt:    new Date(),
            },
            update: {},
          });
        }
        break;
      }

      case 'end-of-call-report': {
        const report      = event;
        const vapiCallId  = report.call?.id || report.callId;
        const transcript  = report.artifact?.transcript || report.transcript || [];
        const recordingUrl = report.artifact?.recordingUrl || report.recordingUrl || null;
        const costUsd     = report.cost || null;

        const endedAt   = report.call?.endedAt ? new Date(report.call.endedAt) : new Date();
        const startedAt = report.call?.startedAt ? new Date(report.call.startedAt) : null;
        const durationSeconds = startedAt
          ? Math.max(0, Math.round((endedAt - startedAt) / 1000))
          : 0;

        const callRecord = await prisma.inboundCall.findFirst({
          where: { vapiCallId },
          include: { assistant: true, tenant: true }
        });
        if (!callRecord) break;

        const { summary, outcome } = inboundSummary.extractSummaryAndOutcome({
          analysis:    report.analysis || report.call?.analysis || {},
          endedReason: report.call?.endedReason || report.endedReason,
        });

        await prisma.inboundCall.update({
          where: { id: callRecord.id },
          data: {
            endedAt:         new Date(),
            durationSeconds,
            outcome,
            summary,
            transcript:      Array.isArray(transcript) ? transcript : [],
            recordingUrl,
            costUsd,
          }
        });

        if (['NO_ANSWER', 'TRANSFERRED', 'FAILED'].includes(outcome)) {
          inboundNotification.notifyCallEnded({
            callerNumber: callRecord.callerNumber,
            outcome,
            summary,
            businessName: callRecord.assistant?.businessName || 'Business',
            ownerWhatsapp: process.env.ADMIN_WHATSAPP,
            duration: durationSeconds,
          }).catch(err => console.error('[webhook/vapi-inbound] notification failed:', err.message));
        }

        console.log(`[webhook/vapi-inbound] Call ${vapiCallId} saved — outcome: ${outcome}, duration: ${durationSeconds}s`);
        break;
      }

      default:
        console.log('[webhook/vapi-inbound] unhandled type:', type);
    }
  } catch (err) {
    console.error('[webhook/vapi-inbound] Error:', err.message, err.stack);
  }
});

module.exports = router
