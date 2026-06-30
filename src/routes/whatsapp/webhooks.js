// backend/src/routes/whatsapp/webhooks.js
//
// Two separate webhook endpoints:
//   GET/POST /meta    — Meta WhatsApp Cloud API (delivery status + inbound messages)
//   POST /vapi-optin  — Vapi call-end events from the opt-in assistant ONLY
//
// The Meta endpoint receives raw body (registered in server.js before express.json)
// so we can verify x-hub-signature-256 against the raw bytes.
// The Vapi endpoint receives parsed JSON — same auth pattern as the main webhook.

const router = require('express').Router()
const crypto = require('crypto')
const prisma = require('../../lib/prisma')
const { processCallOutcome } = require('../../services/waOptIn')
const { handleTemplateStatusWebhook } = require('../../services/waTemplates')

// ── Helpers ──────────────────────────────────────────────────────────────────

function verifyMetaSignature(rawBody, signature) {
  const secret = process.env.WA_APP_SECRET
  if (!secret) return true  // skip in dev if not configured
  if (!signature) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

function verifyVapiRequest(req, rawBodyStr) {
  const secret = process.env.VAPI_WEBHOOK_SECRET
  if (!secret) return true

  const plain = req.headers['x-vapi-secret']
  if (plain) {
    try {
      return crypto.timingSafeEqual(Buffer.from(plain), Buffer.from(secret))
    } catch { /* fall through */ }
  }

  const sig = req.headers['x-vapi-signature']
  if (sig) {
    try {
      const expected = crypto.createHmac('sha256', secret).update(rawBodyStr).digest('hex')
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    } catch { /* fall through */ }
  }

  return false
}

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'cancel', 'stop promo', 'optout', 'opt out', 'opt-out'])

// ── Meta: challenge verification (GET) ───────────────────────────────────────
router.get('/meta', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    console.log('[wa/webhook/meta] verification challenge accepted')
    return res.status(200).send(challenge)
  }
  return res.sendStatus(403)
})

// ── Meta: inbound messages + delivery status (POST) ──────────────────────────
// Body arrives as raw Buffer (registered before express.json in server.js).
router.post('/meta', async (req, res) => {
  // Always 200 fast — Meta retries on anything else
  res.sendStatus(200)

  const rawBody  = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body))
  const signature = req.headers['x-hub-signature-256'] || ''

  if (!verifyMetaSignature(rawBody, signature)) {
    console.error('[wa/webhook/meta] signature mismatch — rejected')
    return
  }

  try {
    const body    = JSON.parse(rawBody.toString())
    const entries = body?.entry || []

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {}

        // a) Template status updates (APPROVED / REJECTED by Meta)
        if (change.field === 'message_template_status_update') {
          await handleTemplateStatusWebhook(value).catch(e =>
            console.error('[wa/webhook/meta] template status error:', e.message)
          )
          continue
        }

        // b) Delivery / read status updates for our outbound messages
        for (const st of value.statuses || []) {
          const statusMap = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' }
          const status    = statusMap[st.status]
          if (status && st.id) {
            await prisma.waMessage.updateMany({ where: { waMessageId: st.id }, data: { status } })
          }
        }

        // b) Inbound messages from contacts
        for (const msg of value.messages || []) {
          const fromE164 = '+' + msg.from
          const text     = (msg.text?.body || msg.button?.text || '').trim()

          const contact = await prisma.waContact.findFirst({ where: { phone: fromE164 } })
          if (!contact) continue

          const isStop = STOP_WORDS.has(text.toLowerCase())

          if (isStop) {
            await prisma.waContact.update({
              where: { id: contact.id },
              data:  { optedOut: true },
            })
            console.log(`[wa/webhook/meta] STOP received from ${fromE164} — contact opted out`)
          } else {
            // Contact messaged us → open / refresh 24-h service window
            await prisma.waContact.update({
              where: { id: contact.id },
              data:  { serviceWindowExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
            })
          }

          await prisma.waMessage.create({
            data: {
              contactId:   contact.id,
              tenantId:    contact.tenantId,
              direction:   'INBOUND',
              status:      'RECEIVED',
              waMessageId: msg.id,
              body:        text || null,
            },
          })
        }
      }
    }
  } catch (err) {
    console.error('[wa/webhook/meta] processing error:', err.message)
  }
})

// ── Vapi: opt-in call events (POST) ──────────────────────────────────────────
// Receives tool-calls and end-of-call-report from the WhatsApp opt-in assistant ONLY.
// The main vapi webhook (/api/webhooks/vapi) is untouched and handles all regular calls.
router.post('/vapi-optin', async (req, res) => {
  const bodyStr = Buffer.isBuffer(req.body)
    ? req.body.toString()
    : JSON.stringify(req.body)

  if (!verifyVapiRequest(req, bodyStr)) {
    console.error('[wa/webhook/vapi-optin] auth rejected')
    return res.status(401).json({ error: 'Invalid signature' })
  }

  let event, type, call
  try {
    const raw = JSON.parse(bodyStr)
    event = raw.message || raw
    type  = event.type
    call  = event.call
  } catch {
    return res.status(200).json({ received: true })
  }

  // Verify this is actually our opt-in assistant — ignore anything else
  const expectedAssistantId = process.env.WA_OPTIN_ASSISTANT_ID
  if (expectedAssistantId && call?.assistantId && call.assistantId !== expectedAssistantId) {
    console.warn('[wa/webhook/vapi-optin] unexpected assistantId:', call.assistantId)
    return res.status(200).json({ received: true })
  }

  console.log('[wa/webhook/vapi-optin] type:', type, '| callId:', call?.id)

  // tool-calls must be answered synchronously
  if (type === 'tool-calls') {
    try {
      const results = await handleOptInToolCalls(event)
      return res.status(200).json({ results })
    } catch (err) {
      console.error('[wa/webhook/vapi-optin] tool-calls error:', err.message)
      return res.status(200).json({ results: [] })
    }
  }

  // All other events: respond immediately, process async
  res.status(200).json({ received: true })

  if (!call?.id) return

  try {
    if (type === 'end-of-call-report' || type === 'call-ended') {
      await handleOptInCallEnded(event)
    }
  } catch (err) {
    console.error('[wa/webhook/vapi-optin] error:', err.message)
  }
})

/**
 * The opt-in assistant fires record_consent({ decision: "yes"|"no"|"unclear" })
 * mid-call when the customer gives a clear answer. We act on it immediately and
 * return a confirmation string so the assistant can wrap up the call.
 */
async function handleOptInToolCalls(event) {
  const toolCalls = event.toolCallList || event.toolCalls || []
  const results   = []
  const call      = event.call

  for (const tc of toolCalls) {
    const name = tc.function?.name || tc.name
    const args = tc.function?.arguments || tc.arguments || {}
    const id   = tc.id

    if (name === 'record_consent') {
      const decision    = (args.decision || '').toLowerCase()
      const contactId   = call?.metadata?.waContactId
      const vapiCallId  = call?.id

      const outcome = await processCallOutcome({
        vocallmCallId: vapiCallId,
        rawOutcome:    decision,
        contactId,
      })

      const reply = decision === 'yes'
        ? 'Great, I have recorded your consent. You will receive our WhatsApp messages. Thank you!'
        : 'Understood, I have noted your preference. We will not send you WhatsApp messages. Have a great day!'

      results.push({ toolCallId: id, result: reply })
      console.log(`[wa/webhook/vapi-optin] record_consent decision="${decision}" → status=${outcome.status}`)
    } else {
      results.push({ toolCallId: id, result: `Unknown tool: ${name}` })
    }
  }

  return results
}

/**
 * Fallback for calls that end without a record_consent tool call
 * (no answer, voicemail, technical failure). Maps Vapi's endedReason
 * to our OptInStatus the same way the WhatsApp optIn service does.
 */
async function handleOptInCallEnded(event) {
  const call        = event.call || event
  const endedReason = event.endedReason || call.endedReason
  const artifact    = event.artifact || call.artifact || {}
  const contactId   = call.metadata?.waContactId
  const vapiCallId  = call.id

  const rawOutcome = mapVapiReason(endedReason)

  await processCallOutcome({
    vocallmCallId: vapiCallId,
    rawOutcome,
    transcript:   formatTranscript(artifact.transcript),
    recordingUrl: artifact.recordingUrl || null,
    contactId,
  })
}

function mapVapiReason(reason) {
  if (!reason) return 'unclear'
  const r = reason.toLowerCase()
  if (r.includes('no-answer') || r.includes('customer-did-not-answer')) return 'no_answer'
  if (r.includes('voicemail')) return 'voicemail'
  if (r.includes('error'))     return 'failed'
  // customer-ended / assistant-ended = call completed normally;
  // if record_consent was already called, the contact status is already set.
  // If not (shouldn't happen), treat as unclear.
  return 'unclear'
}

function formatTranscript(input) {
  if (!input) return null
  if (typeof input === 'string') return input
  if (Array.isArray(input)) {
    return input
      .map(m => `[${(m.role || 'UNKNOWN').toUpperCase()}] ${m.content || m.message || ''}`)
      .filter(l => l.length > 10)
      .join('\n')
  }
  return null
}

module.exports = router
