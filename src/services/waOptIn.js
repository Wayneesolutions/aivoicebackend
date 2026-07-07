// backend/src/services/waOptIn.js
//
// THE ONLY CODE PATH that may set WaContact.optInStatus = OPTED_IN.
// Called from the Vapi opt-in webhook (routes/whatsapp/webhooks.js)
// when the opt-in assistant fires the record_consent tool with decision = "yes".
// All other callers get non-OPTED_IN statuses.

const prisma = require('../lib/prisma')

const OUTCOME_MAP = {
  yes:        'OPTED_IN',
  confirmed:  'OPTED_IN',
  opted_in:   'OPTED_IN',
  no:         'DECLINED',
  declined:   'DECLINED',
  no_answer:  'NO_ANSWER',
  noanswer:   'NO_ANSWER',
  voicemail:  'VOICEMAIL',
  failed:     'FAILED',
}

function mapOutcome(raw) {
  if (!raw) return 'NEEDS_MANUAL_REVIEW'
  const key = String(raw).toLowerCase().trim().replace(/[\s-]+/g, '_')
  return OUTCOME_MAP[key] || 'NEEDS_MANUAL_REVIEW'
}

/**
 * Called when a Quor / Vapi opt-in call finishes.
 * Finds the WaContact by contactId (from call metadata) or vocallmCallId,
 * updates the CallAttempt, and sets the contact's optInStatus.
 *
 * @param {object} p
 * @param {string}  p.vocallmCallId  - Vapi call ID
 * @param {string}  p.rawOutcome     - e.g. "yes" | "no" | "voicemail"
 * @param {string} [p.transcript]
 * @param {string} [p.recordingUrl]
 * @param {string} [p.contactId]     - from call metadata (preferred)
 */
async function processCallOutcome({ vocallmCallId, rawOutcome, transcript, recordingUrl, contactId }) {
  let contact = null

  if (contactId) {
    contact = await prisma.waContact.findUnique({ where: { id: contactId } })
  }

  if (!contact && vocallmCallId) {
    const attempt = await prisma.waCallAttempt.findFirst({
      where:   { vocallmCallId },
      orderBy: { placedAt: 'desc' },
    })
    if (attempt) contact = await prisma.waContact.findUnique({ where: { id: attempt.contactId } })
  }

  if (!contact) {
    console.warn('[waOptIn] contact not found — callId:', vocallmCallId, 'contactId:', contactId)
    return { ok: false, reason: 'contact_not_found', vocallmCallId }
  }

  const status = mapOutcome(rawOutcome)
  console.log(`[waOptIn] contact=${contact.id} rawOutcome="${rawOutcome}" → status=${status}`)

  // Update the call attempt record
  await prisma.waCallAttempt.updateMany({
    where: { contactId: contact.id, vocallmCallId },
    data:  { outcome: status, transcript, recordingUrl, completedAt: new Date() },
  })

  // OPTED_IN requires the full compliance audit stamp. All other statuses just
  // update the status field — no stamp, no way to masquerade as opted in.
  const updateData = status === 'OPTED_IN'
    ? {
        optInStatus:       'OPTED_IN',
        optInSource:       'vocallm_call',
        optInTimestamp:    new Date(),
        optInCallId:       vocallmCallId || null,
        optInRecordingUrl: recordingUrl  || null,
      }
    : { optInStatus: status }

  await prisma.waContact.update({ where: { id: contact.id }, data: updateData })

  return { ok: true, contactId: contact.id, status }
}

module.exports = { processCallOutcome, mapOutcome }
