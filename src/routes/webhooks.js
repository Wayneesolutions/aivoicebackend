// backend/src/routes/webhooks.js
// Vapi sends every call event here — this is the brain of the post-call processing
const router = require('express').Router()
const crypto = require('crypto')
const { PrismaClient } = require('@prisma/client')
const calendarService = require('../services/calendar')
const crmService      = require('../services/crm')
const billingService  = require('../services/billing')
const prisma = new PrismaClient()

// Vapi sends x-vapi-secret header with the raw secret value (not HMAC)
function verifyVapiSignature(signatureHeader) {
  const secret = process.env.VAPI_WEBHOOK_SECRET
  if (!secret) return true
  if (!signatureHeader) return false
  return signatureHeader === secret
}

// POST /api/webhooks/vapi
router.post('/vapi', async (req, res) => {
  // Log every incoming request for debugging
  console.log('[webhook/vapi] INCOMING — headers:', JSON.stringify(req.headers))

  const secret = req.headers['x-vapi-secret']
  // Temporarily skip auth so we can see if webhooks arrive at all
  // if (!verifyVapiSignature(secret)) {
  //   console.warn('[webhook/vapi] Rejected — invalid x-vapi-secret')
  //   return res.status(401).json({ error: 'Invalid webhook signature' })
  // }

  // Always respond 200 immediately — Vapi retries on timeout
  res.status(200).json({ received: true })

  try {
    const bodyStr = req.body.toString()
    console.log('[webhook/vapi] RAW BODY:', bodyStr.slice(0, 500))

    const raw = JSON.parse(bodyStr)
    // Vapi wraps payload in a 'message' key for server-url webhooks
    const event = raw.message || raw
    const { type, call } = event

    console.log('[webhook/vapi] TYPE:', type, '| CALL ID:', call?.id || '')

    if (!call?.id) return

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
      case 'tool-calls':
        await handleToolCalls(event)
        break
      case 'function-call':
        await handleFunctionCall(event)
        break
      case 'transcript':
        await handleTranscriptUpdate(call)
        break
      default:
        // Log unknown types so we can see what Vapi sends
        console.log('[webhook/vapi] unhandled type:', type, JSON.stringify(event).slice(0, 200))
    }
  } catch (err) {
    console.error('[webhook/vapi] Error processing event:', err.message, err.stack)
  }
})

// ── EVENT HANDLERS ────────────────────────────────────────

async function handleCallStarted(call) {
  await prisma.call.updateMany({
    where: { vapiCallId: call.id },
    data: { status: 'IN_PROGRESS', startedAt: new Date() }
  })

  // Update lead status
  const callRecord = await prisma.call.findFirst({ where: { vapiCallId: call.id } })
  if (callRecord) {
    await prisma.lead.update({
      where: { id: callRecord.leadId },
      data: { status: 'CALLING' }
    })
  }
}

async function handleCallEnded(event) {
  // Vapi sends end-of-call-report with call, artifact, analysis at top level of message
  const call = event.call || event
  const artifact = event.artifact || call.artifact || {}
  const analysis = event.analysis || call.analysis || {}
  const endedReason = event.endedReason || call.endedReason

  const callRecord = await prisma.call.findFirst({
    where: { vapiCallId: call.id },
    include: { tenant: true, lead: true }
  })
  if (!callRecord) return

  const durationSeconds = call.endedAt && call.startedAt
    ? Math.floor((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
    : 0

  const outcome = mapVapiEndReason(endedReason) || 'NO_ANSWER'
  const transcript = formatTranscript(artifact.transcript)
  const summary = analysis.summary || null
  const recordingUrl = artifact.recordingUrl || null

  // Calculate billing
  const billedMinutes = Math.ceil(durationSeconds / 6) / 10  // round up to 0.1 min
  const billedAmount  = billedMinutes * callRecord.tenant.ratePerMinute

  // Update call record
  await prisma.call.update({
    where: { id: callRecord.id },
    data: {
      status: 'COMPLETED',
      outcome,
      durationSeconds,
      transcript,
      summary,
      recordingUrl,
      billedMinutes,
      billedAmount,
      endedAt: new Date()
    }
  })

  // Update lead status
  const leadStatus = outcomeToLeadStatus(outcome)
  await prisma.lead.update({
    where: { id: callRecord.leadId },
    data: { status: leadStatus }
  })

  // Log usage for billing
  if (billedMinutes > 0) {
    await billingService.logUsage({
      tenantId:     callRecord.tenantId,
      callId:       callRecord.id,
      minutes:      billedMinutes,
      ratePerMinute: callRecord.tenant.ratePerMinute,
      amount:       billedAmount
    })
  }

  // Log to CRM (async, don't block)
  crmService.logCall({
    tenant:       callRecord.tenant,
    lead:         callRecord.lead,
    call:         { ...callRecord, durationSeconds, outcome, transcript, summary }
  }).catch(err => console.error('[crm] Log failed:', err.message))
}

// Newer Vapi format: type=tool-calls with toolCallList array
async function handleToolCalls(event) {
  const { call, toolCallList = [] } = event
  for (const toolCall of toolCallList) {
    const name = toolCall.function?.name
    let parameters = {}
    try {
      parameters = typeof toolCall.function?.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : (toolCall.function?.arguments || {})
    } catch {}

    const callRecord = await prisma.call.findFirst({
      where: { vapiCallId: call.id },
      include: { tenant: true, lead: true }
    })
    if (!callRecord) continue

    if (name === 'book_meeting') await processMeetingBooking({ callRecord, parameters })
    if (name === 'request_callback') {
      const callbackAt = parseCallbackTime(parameters.callback_time)
      await prisma.lead.update({ where: { id: callRecord.leadId }, data: { status: 'CALLBACK', callbackAt } })
    }
    if (name === 'end_call') {
      await prisma.call.update({ where: { id: callRecord.id }, data: { outcome: parameters.reason, summary: parameters.summary } })
    }
  }
}

// Older Vapi format: type=function-call with functionCall object
async function handleFunctionCall(event) {
  const { call, functionCall } = event
  const { name, parameters } = functionCall

  const callRecord = await prisma.call.findFirst({
    where: { vapiCallId: call.id },
    include: { tenant: true, lead: true }
  })
  if (!callRecord) return

  if (name === 'book_meeting') {
    await processMeetingBooking({ callRecord, parameters })
  }

  if (name === 'request_callback') {
    const callbackAt = parseCallbackTime(parameters.callback_time)
    await prisma.lead.update({
      where: { id: callRecord.leadId },
      data: { status: 'CALLBACK', callbackAt }
    })
  }

  if (name === 'end_call') {
    await prisma.call.update({
      where: { id: callRecord.id },
      data: { outcome: parameters.reason, summary: parameters.summary }
    })
  }
}

async function handleTranscriptUpdate(call) {
  const transcript = formatTranscript(call.artifact?.transcript)
  if (!transcript) return
  await prisma.call.updateMany({
    where: { vapiCallId: call.id },
    data: { transcript }
  })
}

// ── MEETING BOOKING ───────────────────────────────────────

async function processMeetingBooking({ callRecord, parameters }) {
  const { tenant, lead } = callRecord
  try {
    const booking = await calendarService.bookMeeting({
      tenant,
      prospectName:  parameters.prospect_name  || lead.name,
      prospectEmail: parameters.prospect_email || lead.email,
      preferredSlot: parameters.preferred_slot,
      notes:         parameters.notes || ''
    })

    await prisma.call.update({
      where: { id: callRecord.id },
      data: {
        outcome:        'BOOKED',
        meetingBookedAt: new Date(),
        meetingLink:    booking.meetingUrl || null,
        calEventId:     booking.uid || null
      }
    })

    await prisma.lead.update({
      where: { id: callRecord.leadId },
      data: {
        status:          'BOOKED',
        meetingBookedAt: new Date(),
        meetingLink:     booking.meetingUrl || null
      }
    })
  } catch (err) {
    console.error('[webhook] Meeting booking failed:', err.message)
  }
}

// ── HELPERS ───────────────────────────────────────────────

function formatTranscript(vapiTranscript) {
  if (!vapiTranscript || !Array.isArray(vapiTranscript)) return null
  return vapiTranscript
    .map(t => `[${t.role.toUpperCase()}] ${t.message}`)
    .join('\n')
}

function mapVapiEndReason(reason) {
  const map = {
    'customer-ended-call':      'NOT_INTERESTED',
    'assistant-ended-call':     'BOOKED',
    'customer-did-not-answer':  'NO_ANSWER',
    'voicemail':                'VOICEMAIL',
    'max-duration-exceeded':    'NO_ANSWER',
    'silence-timed-out':        'NO_ANSWER',
    'error':                    'ERROR'
  }
  return map[reason] || 'NO_ANSWER'
}

function outcomeToLeadStatus(outcome) {
  const map = {
    BOOKED:          'BOOKED',
    NOT_INTERESTED:  'NOT_INTERESTED',
    CALLBACK:        'CALLBACK',
    VOICEMAIL:       'VOICEMAIL',
    NO_ANSWER:       'NO_ANSWER',
    WRONG_NUMBER:    'WRONG_NUMBER',
    OPTED_OUT:       'OPTED_OUT',
    ERROR:           'PENDING'  // retry errors
  }
  return map[outcome] || 'NO_ANSWER'
}

function parseCallbackTime(text) {
  try {
    const d = new Date(text)
    if (!isNaN(d)) return d
  } catch {}
  // Default: call back tomorrow same time
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  return tomorrow
}

module.exports = router
