// backend/src/routes/webhooks.js
// ============================================================
// BUGFIX — webhooks.js
// BUGS FIXED:
//   BUG-3: processMeetingBooking catch block set outcome:'BOOKED' even when
//           Cal.com call failed. Leads silently lost with no actual booking.
//           Fixed: catch now sets outcome:'CALLBACK' so team can follow up.
//   BUG-4: err.message masked actual Cal.com API error detail.
//           Fixed: err.response?.data || err.message for full error.
//   BUG-5: Campaign timezone not passed to calendarService.bookMeeting().
//           Fixed: campaign included in query, timezone passed through.
// ALL FIX-04 changes (sentimentLog) are preserved unchanged.
// ============================================================

const router = require('express').Router()
const crypto = require('crypto')
const prisma = require('../lib/prisma')
const calendarService = require('../services/calendar')
const crmService      = require('../services/crm')
const billingService  = require('../services/billing')

function verifyVapiSignature(signatureHeader) {
  const secret = process.env.VAPI_WEBHOOK_SECRET
  if (!secret) return true
  if (!signatureHeader) return false
  try {
    const a = Buffer.from(signatureHeader)
    const b = Buffer.from(secret)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

router.post('/vapi', async (req, res) => {
  console.log('[webhook/vapi] INCOMING — headers:', JSON.stringify(req.headers))

  const secret = req.headers['x-vapi-secret']
  if (!verifyVapiSignature(secret)) {
    console.warn('[webhook/vapi] Rejected — invalid x-vapi-secret')
    return res.status(401).json({ error: 'Invalid webhook signature' })
  }

  let event, type, call
  try {
    const bodyStr = req.body.toString()
    console.log('[webhook/vapi] RAW BODY:', bodyStr.slice(0, 500))
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
  // Responding with anything else makes the AI say "there was a technical issue"
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
        if (type === 'call-started' || event.status === 'in-progress') {
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

  const startedAt = call.startedAt ? new Date(call.startedAt) : callRecord.startedAt
  const endedAt   = call.endedAt   ? new Date(call.endedAt)   : new Date()
  const durationSeconds = startedAt ? Math.floor((endedAt - startedAt) / 1000) : 0

  console.log(`[webhook] handleCallEnded — vapiId=${call.id} endedReason=${endedReason} duration=${durationSeconds}s`)

  const mappedOutcome = mapVapiEndReason(endedReason) || 'NO_ANSWER'
  const outcome = callRecord.meetingBookedAt ? 'BOOKED' : mappedOutcome

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
    await billingService.logUsage({
      tenantId:      callRecord.tenantId,
      callId:        callRecord.id,
      minutes:       billedMinutes,
      ratePerMinute: callRecord.tenant.ratePerMinute,
      amount:        billedAmount
    })
  }

  crmService.logCall({
    tenant: callRecord.tenant,
    lead:   callRecord.lead,
    call:   { ...callRecord, durationSeconds, outcome, transcript, summary }
  }).catch(err => console.error('[crm] Log failed:', err.message))
}

async function handleToolCalls(event) {
  const { call, toolCallList = [] } = event
  const results = []

  for (const toolCall of toolCallList) {
    const toolCallId = toolCall.id
    const name = toolCall.function?.name
    let parameters = {}
    try {
      parameters = typeof toolCall.function?.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : (toolCall.function?.arguments || {})
    } catch {}

    console.log(`[webhook] tool-call: ${name}`, JSON.stringify(parameters))

    const callRecord = await prisma.call.findFirst({
      where: { vapiCallId: call.id },
      include: { tenant: true, lead: true, campaign: true }  // FIX BUG-5: include campaign for timezone
    })
    if (!callRecord) {
      results.push({ toolCallId, result: 'Internal error: call record not found.' })
      continue
    }

    let result = 'Done.'
    try {
      if (name === 'book_meeting')     result = await processMeetingBooking({ callRecord, parameters })
      if (name === 'request_callback') result = await processCallback({ callRecord, parameters })
      if (name === 'end_call')         { await processEndCall({ callRecord, parameters }); result = 'Call ended.' }
      if (name === 'detect_sentiment') { await handleSentiment({ callRecord, parameters }); result = 'Sentiment recorded.' }
    } catch (err) {
      console.error(`[webhook] Error in tool ${name}:`, err.message)
      result = "Noted. I'll follow up on that."
    }

    results.push({ toolCallId, result })
  }

  return results
}

async function handleFunctionCall(event) {
  const { call, functionCall } = event
  const { name, parameters } = functionCall

  const callRecord = await prisma.call.findFirst({
    where: { vapiCallId: call.id },
    include: { tenant: true, lead: true, campaign: true }  // FIX BUG-5: include campaign for timezone
  })
  if (!callRecord) return

  if (name === 'book_meeting')     await processMeetingBooking({ callRecord, parameters })
  if (name === 'request_callback') await processCallback({ callRecord, parameters })
  if (name === 'end_call')         await processEndCall({ callRecord, parameters })
  if (name === 'detect_sentiment') await handleSentiment({ callRecord, parameters })
}

// Stores sentiment snapshot from AI into Call.sentimentLog
async function handleSentiment({ callRecord, parameters }) {
  const { sentiment, intent, buying_signal, suggested_action } = parameters
  console.log(`[webhook] detect_sentiment — call=${callRecord.id} sentiment=${sentiment} intent=${intent} action=${suggested_action}`)

  try {
    const existing = callRecord.sentimentLog || []
    const entry = {
      ts:               new Date().toISOString(),
      sentiment,
      intent,
      buying_signal:    buying_signal || null,
      suggested_action
    }
    const updated = Array.isArray(existing) ? [...existing, entry] : [entry]

    await prisma.call.update({
      where: { id: callRecord.id },
      data: { sentimentLog: updated }
    })
  } catch (err) {
    console.error('[webhook] Could not save sentiment — did you run the migration?', err.message)
  }
}

async function processCallback({ callRecord, parameters }) {
  const callbackAt = parseCallbackTime(parameters.callback_time)
  await prisma.lead.update({ where: { id: callRecord.leadId }, data: { status: 'CALLBACK', callbackAt } })
  return `Got it — I've noted your callback for ${parameters.callback_time}. We'll call you back then.`
}

async function processEndCall({ callRecord, parameters }) {
  await prisma.call.update({
    where: { id: callRecord.id },
    data: { outcome: parameters.reason, summary: parameters.summary }
  })
}

async function handleTranscriptUpdate(call) {
  const transcript = formatTranscript(call.artifact?.transcript)
  if (!transcript) return
  await prisma.call.updateMany({
    where: { vapiCallId: call.id },
    data: { transcript }
  })
}

async function processMeetingBooking({ callRecord, parameters }) {
  const { tenant, lead, campaign } = callRecord
  console.log('[webhook] book_meeting called — params:', JSON.stringify(parameters))

  // FIX BUG-5: extract campaign timezone so calendar uses correct local time
  const campaignTimezone = campaign?.timezone || 'America/Toronto'

  const scheduledMeetingAt = parsePreferredSlot(parameters.preferred_slot)

  try {
    const booking = await calendarService.bookMeeting({
      tenant,
      prospectName:  parameters.prospect_name  || lead.name,
      prospectEmail: parameters.prospect_email || lead.email,
      preferredSlot: parameters.preferred_slot,
      notes:         parameters.notes || '',
      timezone:      campaignTimezone    // FIX BUG-5: pass timezone
    })

    const confirmedAt = booking.startTime ? new Date(booking.startTime) : scheduledMeetingAt

    await prisma.call.update({
      where: { id: callRecord.id },
      data: {
        outcome:            'BOOKED',
        meetingBookedAt:    new Date(),
        scheduledMeetingAt: confirmedAt,
        meetingLink:        booking.meetingUrl || null,
        calEventId:         booking.uid || null
      }
    })

    await prisma.lead.update({
      where: { id: callRecord.leadId },
      data: { status: 'BOOKED', meetingBookedAt: new Date(), meetingLink: booking.meetingUrl || null }
    })

    console.log(`[webhook] Meeting booked successfully — lead ${callRecord.leadId}, scheduledAt: ${confirmedAt}`)
    return `Meeting confirmed for ${parameters.preferred_slot}. You'll receive a confirmation shortly.`

  } catch (err) {
    // FIX BUG-4: log actual Cal.com error response, not just generic message
    console.error('[webhook] Meeting booking failed:', err.response?.data || err.message)

    // FIX BUG-3: DO NOT mark as BOOKED when booking failed.
    // Set CALLBACK so the lead re-enters the queue for team follow-up.
    await prisma.call.update({
      where: { id: callRecord.id },
      data: {
        outcome:            'CALLBACK',   // was: 'BOOKED' — WRONG
        meetingBookedAt:    null,         // no meeting was actually created
        scheduledMeetingAt: scheduledMeetingAt
      }
    }).catch(() => {})

    await prisma.lead.update({
      where: { id: callRecord.leadId },
      data: {
        status:     'CALLBACK',           // was: 'BOOKED' — WRONG
        callbackAt: scheduledMeetingAt    // team will call back around that time
      }
    }).catch(() => {})

    return `I wasn't able to confirm that slot right now. Our team will call you back to finalise the time.`
  }
}

function parsePreferredSlot(slot) {
  if (!slot) return null
  try {
    const d = new Date(slot)
    if (!isNaN(d.getTime())) return d
  } catch {}
  return null
}

function formatTranscript(msgs) {
  if (!msgs || !Array.isArray(msgs) || msgs.length === 0) return null
  const lines = msgs
    .map(t => {
      const role = (t.role || 'unknown').toUpperCase()
      const text = t.message || t.content || t.text || ''
      return text ? `[${role}] ${text}` : null
    })
    .filter(Boolean)
  return lines.length ? lines.join('\n') : null
}

function mapVapiEndReason(reason) {
  const map = {
    'customer-ended-call':     'NOT_INTERESTED',
    'assistant-ended-call':    'NOT_INTERESTED',
    'customer-did-not-answer': 'NO_ANSWER',
    'voicemail':               'VOICEMAIL',
    'max-duration-exceeded':   'NO_ANSWER',
    'silence-timed-out':       'NO_ANSWER',
    'error':                   'ERROR'
  }
  return map[reason] || 'NO_ANSWER'
}

function outcomeToLeadStatus(outcome) {
  const map = {
    BOOKED:         'BOOKED',
    NOT_INTERESTED: 'NOT_INTERESTED',
    CALLBACK:       'CALLBACK',
    VOICEMAIL:      'VOICEMAIL',
    NO_ANSWER:      'NO_ANSWER',
    WRONG_NUMBER:   'WRONG_NUMBER',
    OPTED_OUT:      'OPTED_OUT',
    ERROR:          'PENDING'
  }
  return map[outcome] || 'NO_ANSWER'
}

function parseCallbackTime(text) {
  try {
    const d = new Date(text)
    if (!isNaN(d)) return d
  } catch {}
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  return tomorrow
}

module.exports = router
