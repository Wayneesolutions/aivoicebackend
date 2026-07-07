// backend/src/services/phoneProviders.js
// Unified search + buy for Twilio and Plivo numbers, plus Vapi registration

const twilio = require('twilio')
const plivo  = require('plivo')
const axios  = require('axios')

// ── Clients ───────────────────────────────────────────────────────────────────

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
}

function getPlivoClient() {
  return new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN)
}

const vapiClient = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }
})

// ── Search ────────────────────────────────────────────────────────────────────

async function searchTwilio({ country = 'US', areaCode, contains, limit = 20 }) {
  const client = getTwilioClient()
  const params = { limit, voiceEnabled: true }
  if (areaCode) params.areaCode = areaCode
  if (contains) params.contains = contains

  const numbers = await client.availablePhoneNumbers(country).local.list(params)

  return numbers.map(n => ({
    number:       n.phoneNumber,
    friendlyName: n.friendlyName,
    country,
    provider:     'TWILIO',
    locality:     n.locality ?? '',
    region:       n.region ?? '',
    monthlyPrice: null, // Twilio doesn't return price in search
  }))
}

async function searchPlivo({ country = 'IN', pattern, limit = 20 }) {
  const client = getPlivoClient()
  const params = { type: 'local', services: 'voice', limit }
  if (pattern) params.pattern = pattern

  const res = await client.numbers.search(country, params)
  const objects = res.objects ?? []

  return objects.map(n => ({
    number:       n.number,
    friendlyName: n.number,
    country,
    provider:     'PLIVO',
    locality:     '',
    region:       n.region ?? '',
    monthlyPrice: n.monthly_rental_rate ?? null,
  }))
}

async function searchAvailable({ provider, country, areaCode, contains, pattern, limit }) {
  if (provider === 'PLIVO') return searchPlivo({ country, pattern, limit })
  return searchTwilio({ country, areaCode, contains, limit })
}

// ── Buy ───────────────────────────────────────────────────────────────────────

async function buyTwilio(number) {
  const client = getTwilioClient()
  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber:  number,
    friendlyName: `Quor — ${number}`,
  })
  return { twilioSid: purchased.sid, plivoUuid: null }
}

async function buyPlivo(number) {
  const client = getPlivoClient()
  // Plivo buy: POST /Account/{auth_id}/PhoneNumber/{number}/
  const res = await client.numbers.buy(number.replace('+', ''))
  const uuid = res.numbers?.[0]?.number ?? number
  return { twilioSid: null, plivoUuid: uuid }
}

// ── Vapi registration ─────────────────────────────────────────────────────────

async function registerInVapiTwilio(number) {
  const res = await vapiClient.post('/phone-number', {
    provider:         'twilio',
    number,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken:  process.env.TWILIO_AUTH_TOKEN,
  })
  return res.data.id
}

async function registerInVapiPlivo(number) {
  // Requires PLIVO_VAPI_CREDENTIAL_ID:
  // 1. Add Plivo as a SIP trunk in Vapi Dashboard → Credentials
  // 2. Paste the resulting credential ID into your .env as PLIVO_VAPI_CREDENTIAL_ID
  const credentialId = process.env.PLIVO_VAPI_CREDENTIAL_ID
  if (!credentialId) {
    throw new Error(
      'PLIVO_VAPI_CREDENTIAL_ID not set. Add Plivo SIP credentials in Vapi Dashboard → Credentials, then set the ID in .env'
    )
  }
  const res = await vapiClient.post('/phone-number', {
    provider:     'byo-phone-number',
    number,
    credentialId,
  })
  return res.data.id
}

// ── Main: buy + register ──────────────────────────────────────────────────────

async function buyAndRegister({ provider, number }) {
  let twilioSid, plivoUuid, vapiNumberId

  if (provider === 'PLIVO') {
    ;({ twilioSid, plivoUuid } = await buyPlivo(number))
    vapiNumberId = await registerInVapiPlivo(number)
  } else {
    ;({ twilioSid, plivoUuid } = await buyTwilio(number))
    vapiNumberId = await registerInVapiTwilio(number)
  }

  return { twilioSid, plivoUuid, vapiNumberId }
}

async function releaseNumber({ provider, twilioSid, plivoUuid, vapiNumberId }) {
  if (vapiNumberId) {
    await vapiClient.delete(`/phone-number/${vapiNumberId}`)
      .catch(e => console.error('[phoneProviders] Vapi release failed:', e.message))
  }
  if (provider === 'TWILIO' && twilioSid) {
    await getTwilioClient().incomingPhoneNumbers(twilioSid).remove()
      .catch(e => console.error('[phoneProviders] Twilio release failed:', e.message))
  }
  if (provider === 'PLIVO' && plivoUuid) {
    await getPlivoClient().numbers.unrent(plivoUuid.replace('+', ''))
      .catch(e => console.error('[phoneProviders] Plivo release failed:', e.message))
  }
}

module.exports = { searchAvailable, buyAndRegister, releaseNumber }
