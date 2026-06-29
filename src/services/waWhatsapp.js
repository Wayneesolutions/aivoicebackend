// backend/src/services/waWhatsapp.js
//
// THE ONLY MODULE that calls Meta's /messages endpoint.
// The compliance gate lives here and cannot be bypassed:
//   runCampaign() always queries { optInStatus: "OPTED_IN", optedOut: false }
// There is no flag, parameter, or code path that skips this filter.

const axios  = require('axios')
const prisma = require('../lib/prisma')

// Simple concurrency limiter — keeps us under Meta's ~80 msg/sec ceiling
function pLimit(concurrency) {
  let active = 0
  const queue = []
  const next = () => {
    if (queue.length && active < concurrency) {
      const { fn, resolve, reject } = queue.shift()
      active++
      Promise.resolve().then(fn).then(resolve).catch(reject).finally(() => { active--; next() })
    }
  }
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject })
    next()
  })
}

function waClient() {
  return axios.create({
    baseURL: `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || 'v21.0'}`,
    headers: {
      Authorization:  `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  })
}

async function postMessage(payload) {
  const res = await waClient().post(`/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    ...payload,
  })
  return res.data?.messages?.[0]?.id || null
}

/**
 * Send a Meta-approved template message (required for business-initiated conversations).
 * `components` follows Meta's template component spec — pass variable values here.
 * Example for a body with {{1}} = first name:
 *   [{ type: "body", parameters: [{ type: "text", text: "Priya" }] }]
 */
async function sendTemplate(toE164, templateName, languageCode = 'en', components = []) {
  return postMessage({
    to:       toE164.replace('+', ''),
    type:     'template',
    template: {
      name:     templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {}),
    },
  })
}

/**
 * Send a free-form text message.
 * Only valid inside the 24-h customer service window (after the contact messaged us).
 * Meta will reject this outside that window — use sendTemplate instead.
 */
async function sendText(toE164, body) {
  return postMessage({
    to:   toE164.replace('+', ''),
    type: 'text',
    text: { preview_url: false, body },
  })
}

/**
 * Run a WhatsApp campaign: send `templateName` to every OPTED-IN, not-opted-out
 * contact in the given list. Logs a WaMessage row per send attempt (success or fail).
 *
 * buildComponents(contact) → Meta component array (optional; fills {{1}} with first name by default)
 *
 * @returns {{ sent, failed, attempted }}
 */
async function runCampaign({ campaignId, contactListId, templateName, languageCode = 'en', buildComponents }) {
  // THE GATE — enforced at the DB query level, not in JS afterwards.
  // No parameter or flag can bypass this.
  const recipients = await prisma.waContact.findMany({
    where: { contactListId, optInStatus: 'OPTED_IN', optedOut: false },
  })

  if (recipients.length === 0) {
    return { sent: 0, failed: 0, attempted: 0 }
  }

  const concurrency = Math.max(1, parseInt(process.env.WA_SEND_CONCURRENCY || '10', 10))
  const limit       = pLimit(concurrency)
  let sent = 0, failed = 0

  await Promise.all(
    recipients.map(contact => limit(async () => {
      const components = typeof buildComponents === 'function'
        ? buildComponents(contact)
        : [{ type: 'body', parameters: [{ type: 'text', text: contact.fullName?.split(' ')[0] || 'there' }] }]

      try {
        const wamid = await sendTemplate(contact.phone, templateName, languageCode, components)
        await prisma.waMessage.create({
          data: {
            contactId:   contact.id,
            tenantId:    contact.tenantId,
            campaignId:  campaignId ?? null,
            direction:   'OUTBOUND',
            status:      'SENT',
            waMessageId: wamid,
            templateName,
          },
        })
        sent++
      } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message
        console.error(`[waWhatsapp] send failed for ${contact.phone}:`, detail)
        await prisma.waMessage.create({
          data: {
            contactId:   contact.id,
            tenantId:    contact.tenantId,
            campaignId:  campaignId ?? null,
            direction:   'OUTBOUND',
            status:      'FAILED',
            templateName,
            error:       detail?.slice(0, 1000),
          },
        })
        failed++
      }
    }))
  )

  console.log(`[waWhatsapp] campaign=${campaignId} list=${contactListId} sent=${sent} failed=${failed}`)
  return { sent, failed, attempted: recipients.length }
}

module.exports = { sendTemplate, sendText, runCampaign }
