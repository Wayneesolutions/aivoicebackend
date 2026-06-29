// backend/src/services/waVocallm.js
// Places opt-in confirmation calls via Vapi using the dedicated opt-in assistant.
// The call carries metadata { waContactId, isWaOptIn: true } so the opt-in webhook
// can route the result to waOptIn.processCallOutcome without touching the main flow.

const axios  = require('axios')
const prisma = require('../lib/prisma')

const vapiClient = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
  timeout: 15000,
})

/**
 * Place a single opt-in call for a WaContact.
 * Creates a WaCallAttempt and moves the contact to PENDING.
 */
async function placeOptInCall(contact) {
  const assistantId = process.env.WA_OPTIN_ASSISTANT_ID
  if (!assistantId) throw new Error('WA_OPTIN_ASSISTANT_ID not set in .env')

  const res = await vapiClient.post('/call', {
    assistantId,
    customer: {
      number: contact.phone,
      name:   contact.fullName || undefined,
    },
    assistantOverrides: {
      // Metadata comes back in every webhook payload so we know which WaContact
      // this call belongs to without querying by phone number.
      metadata: {
        waContactId: contact.id,
        isWaOptIn:   true,
      },
    },
  })

  const vapiCallId = res.data?.id
  if (!vapiCallId) throw new Error('Vapi did not return a call ID')

  await prisma.waCallAttempt.create({
    data: {
      contactId:     contact.id,
      vocallmCallId: vapiCallId,
      placedAt:      new Date(),
    },
  })

  await prisma.waContact.update({
    where: { id: contact.id },
    data:  { optInStatus: 'PENDING' },
  })

  return vapiCallId
}

/**
 * Trigger opt-in calls for all NOT_CONTACTED contacts in a list.
 * Runs sequentially to avoid hammering Vapi at once.
 */
async function triggerOptInForList(contactListId) {
  const contacts = await prisma.waContact.findMany({
    where: { contactListId, optInStatus: 'NOT_CONTACTED', optedOut: false },
  })

  const results = { placed: 0, failed: 0, errors: [] }

  for (const contact of contacts) {
    try {
      await placeOptInCall(contact)
      results.placed++
    } catch (err) {
      console.error(`[waVocallm] failed for ${contact.phone}:`, err.message)
      results.failed++
      results.errors.push(`${contact.phone}: ${err.message}`)
    }
  }

  console.log(`[waVocallm] list=${contactListId} placed=${results.placed} failed=${results.failed}`)
  return results
}

module.exports = { placeOptInCall, triggerOptInForList }
