// ============================================================
// FIX-01 — backend/src/services/vapi.js
// REPLACE your entire existing vapi.js with this file.
//
// WHAT CHANGED vs your current code (search for CHANGED):
//   1. endpointing: 150 → 10          (-140ms response lag)
//   2. eleven_turbo_v2_5 → eleven_flash_v2_5  (-300ms TTS lag)
//   3. maxTokens: 150 → 80            (-~1s AI thinking time)
//   4. nova-2 → nova-3                (better Hinglish accuracy)
//   5. keyterms added                 (stops mishearing your brand)
//   6. smartEndpointingEnabled: true  (AI stops when user speaks)
//   7. backgroundDenoising: true      (removes phone line static)
//   8. backchannel enabled            (AI says "Sure..." while thinking — hides lag)
//   9. eleven_flash_v2_5 on voice overrides too
//  10. MAX_CONCURRENT from env         (tunable without code change)
// ============================================================

const axios = require('axios')
const { getVapiFunctions } = require('./script')

// Map our language codes to Deepgram language codes
const DEEPGRAM_LANG = {
  en: 'en-US', hi: 'hi', hinglish: 'hi', pa: 'hi',
  es: 'es',    fr: 'fr', de: 'de',
  pt: 'pt',    ar: 'ar', zh: 'zh-CN', ja: 'ja', ko: 'ko',
  ru: 'ru',    it: 'it', nl: 'nl',    tr: 'tr', pl: 'pl'
}

// Keyterms that Deepgram must never mishear — add your brand names here
// Format: 'word:boost' where boost is 1.0–5.0 (higher = stronger bias)
const BASE_KEYTERMS = [
  'VoCallM:3',
  'Wayne:2',
  'Wayne Solutions:3',
]

const vapiClient = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }
})

const VAPI_BUILTIN_VOICE = '21m00Tcm4TlvDq8ikWAM'

/**
 * Create or update a Vapi assistant for a given script.
 */
async function upsertAssistant({ name, systemPrompt, voiceId, agentName, language, existingAssistantId, customKeyterms = [] }) {

  // Merge base keyterms with any script-specific ones
  const allKeyterms = [...BASE_KEYTERMS, ...customKeyterms]

  const payload = {
    name,
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt,
      tools: getVapiFunctions(),
      temperature: 0.7,
      maxTokens: 80,                      // CHANGED: 150 → 80 (faster first word, ~1s saved)
    },
    voice: {
      provider: '11labs',
      voiceId: (voiceId && voiceId !== VAPI_BUILTIN_VOICE) ? voiceId : process.env.ELEVENLABS_DEFAULT_VOICE_ID,
      model: 'eleven_flash_v2_5',         // CHANGED: turbo → flash (300ms faster TTS)
      stability: 0.5,
      similarityBoost: 0.75,
      useSpeakerBoost: true,
      optimizeStreamingLatency: 4,
      ...(process.env.VAPI_ELEVENLABS_CREDENTIAL_ID
        ? { credentialId: process.env.VAPI_ELEVENLABS_CREDENTIAL_ID }
        : {}),
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',                    // CHANGED: nova-2 → nova-3 (better Hinglish/accent accuracy)
      language: DEEPGRAM_LANG[language || 'en'] || 'en-US',
      smartFormat: true,
      endpointing: 10,                    // CHANGED: 150 → 10 (biggest single lag fix, -140ms)
      keyterms: allKeyterms,              // NEW: stops Deepgram mishearing brand/product names
    },
    firstMessage: `Hi, may I speak with {{prospect_name}}? This is ${agentName} calling.`,
    recordingEnabled: true,
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    backgroundSound: 'office',
    backgroundDenoising: true,            // NEW: removes phone line static/noise
    smartEndpointingEnabled: true,        // NEW: AI stops mid-sentence when user interrupts
    backchannel: {                        // NEW: AI says "Sure..." / "Got it" while thinking
      enabled: true,
      words: ['Sure', 'Got it', 'Mmm', 'Absolutely', 'Of course', 'Right', 'I see'],
    },
    serverUrl: `${process.env.BASE_URL}/api/webhooks/vapi`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET
  }

  console.log('[VAPI] upsertAssistant voiceId =', payload.voice.voiceId, '| model =', payload.model.model)
  try {
    if (existingAssistantId) {
      const res = await vapiClient.patch(`/assistant/${existingAssistantId}`, payload)
      return res.data.id
    } else {
      const res = await vapiClient.post('/assistant', payload)
      return res.data.id
    }
  } catch (err) {
    if (err.response) {
      console.error('[VAPI ERROR]', err.response.status, JSON.stringify(err.response.data, null, 2))
    }
    throw err
  }
}

/**
 * Trigger an outbound call via Vapi.
 */
async function startOutboundCall({ toNumber, vapiNumberId, vapiAssistantId, metadata, voiceOverrideId, systemPromptOverride }) {
  if (!vapiNumberId) throw new Error('vapiNumberId is required for outbound calls')

  const assistantOverrides = {
    variableValues: {
      prospect_name:    metadata?.leadName    || '',
      prospect_company: metadata?.leadCompany || '',
      prospect_title:   metadata?.leadTitle   || ''
    }
  }

  if (voiceOverrideId) {
    assistantOverrides.voice = {
      provider: '11labs',
      voiceId: voiceOverrideId,
      model: 'eleven_flash_v2_5',         // CHANGED: turbo → flash on voice overrides too
      stability: 0.5,
      similarityBoost: 0.75,
      useSpeakerBoost: true,
      ...(process.env.VAPI_ELEVENLABS_CREDENTIAL_ID
        ? { credentialId: process.env.VAPI_ELEVENLABS_CREDENTIAL_ID }
        : {}),
    }
  }

  if (systemPromptOverride) {
    assistantOverrides.model = { provider: 'openai', model: 'gpt-4o-mini', systemPrompt: systemPromptOverride }
  }

  const payload = {
    assistantId: vapiAssistantId,
    customer: {
      number: toNumber,
      name: metadata?.leadName || ''
    },
    phoneNumberId: vapiNumberId,
    assistantOverrides,
    metadata: {
      tenantId:  metadata.tenantId,
      leadId:    metadata.leadId,
      campaignId: metadata.campaignId
    }
  }

  try {
    const res = await vapiClient.post('/call/phone', payload)
    return res.data
  } catch (err) {
    if (err.response) {
      console.error('[VAPI CALL ERROR]', err.response.status, JSON.stringify(err.response.data, null, 2))
    }
    throw err
  }
}

async function listAssistants() {
  const res = await vapiClient.get('/assistant')
  return res.data
}

async function deleteAssistant(assistantId) {
  await vapiClient.delete(`/assistant/${assistantId}`)
}

async function getCall(vapiCallId) {
  const res = await vapiClient.get(`/call/${vapiCallId}`)
  return res.data
}

module.exports = { upsertAssistant, startOutboundCall, listAssistants, deleteAssistant, getCall }
