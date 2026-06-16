// backend/src/services/vapi.js
const axios = require('axios')
const { getVapiFunctions } = require('./script')

// Map our BCP-47 codes to Deepgram language codes
const DEEPGRAM_LANG = {
  en: 'en-US', hi: 'hi',  es: 'es',    fr: 'fr',  de: 'de',
  pt: 'pt',    ar: 'ar',  zh: 'zh-CN', ja: 'ja',  ko: 'ko',
  ru: 'ru',    it: 'it',  nl: 'nl',    tr: 'tr',  pl: 'pl'
}

const vapiClient = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }
})

// This was the old Vapi built-in default — it only works without custom 11labs credentials.
// Any script created before the migration still has this stored; treat it as "use env default".
const VAPI_BUILTIN_VOICE = '21m00Tcm4TlvDq8ikWAM'

/**
 * Create or update a Vapi assistant for a given script.
 * Returns the Vapi assistant ID.
 */
async function upsertAssistant({ name, systemPrompt, voiceId, agentName, language, existingAssistantId }) {
  const payload = {
    name,
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt,
      tools: getVapiFunctions(),
      temperature: 0.7,
      maxTokens: 150
    },
    voice: {
      provider: '11labs',
      voiceId: (voiceId && voiceId !== VAPI_BUILTIN_VOICE) ? voiceId : process.env.ELEVENLABS_DEFAULT_VOICE_ID,
      // turbo_v2_5 = ~40% lower latency vs multilingual_v2, still supports Hindi/Hinglish
      model: 'eleven_turbo_v2_5',
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
      model: 'nova-2',
      language: DEEPGRAM_LANG[language || 'en'] || 'en-US',
      smartFormat: true,
      endpointing: 150
    },
    // {{prospect_name}} is injected per-call via assistantOverrides.variableValues
    firstMessage: `Hi, may I speak with {{prospect_name}}? This is ${agentName} calling.`,
    recordingEnabled: true,
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    backgroundSound: 'office',
    serverUrl: `${process.env.BASE_URL}/api/webhooks/vapi`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET
  }

  console.log('[VAPI] upsertAssistant voiceId =', payload.voice.voiceId, '| env default =', process.env.ELEVENLABS_DEFAULT_VOICE_ID)
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
 * Returns the Vapi call object.
 */
async function startOutboundCall({ toNumber, vapiNumberId, vapiAssistantId, metadata, voiceOverrideId }) {
  if (!vapiNumberId) throw new Error('vapiNumberId is required for outbound calls')

  const assistantOverrides = {
    variableValues: {
      prospect_name:    metadata?.leadName    || '',
      prospect_company: metadata?.leadCompany || '',
      prospect_title:   metadata?.leadTitle   || ''
    }
  }

  // If this tenant has uploaded their own cloned voice, use it for every call
  if (voiceOverrideId) {
    assistantOverrides.voice = {
      provider: '11labs',
      voiceId: voiceOverrideId,
      model: 'eleven_turbo_v2_5',
      stability: 0.5,
      similarityBoost: 0.75,
      useSpeakerBoost: true,
      ...(process.env.VAPI_ELEVENLABS_CREDENTIAL_ID
        ? { credentialId: process.env.VAPI_ELEVENLABS_CREDENTIAL_ID }
        : {}),
    }
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
      tenantId:      metadata.tenantId,
      leadId:        metadata.leadId,
      campaignId:    metadata.campaignId
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

/**
 * Get a list of all Vapi assistants (for admin panel)
 */
async function listAssistants() {
  const res = await vapiClient.get('/assistant')
  return res.data
}

/**
 * Delete a Vapi assistant
 */
async function deleteAssistant(assistantId) {
  await vapiClient.delete(`/assistant/${assistantId}`)
}

/**
 * Get call details from Vapi (for fetching transcript/recording after call ends)
 */
async function getCall(vapiCallId) {
  const res = await vapiClient.get(`/call/${vapiCallId}`)
  return res.data
}

module.exports = { upsertAssistant, startOutboundCall, listAssistants, deleteAssistant, getCall }
