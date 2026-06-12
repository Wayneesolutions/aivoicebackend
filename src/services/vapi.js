// backend/src/services/vapi.js
const axios = require('axios')
const { getVapiFunctions } = require('./script')

const vapiClient = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }
})

/**
 * Create or update a Vapi assistant for a given script.
 * Returns the Vapi assistant ID.
 */
async function upsertAssistant({ name, systemPrompt, voiceId, agentName, existingAssistantId }) {
  const payload = {
    name,
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt,
      tools: getVapiFunctions(),
      temperature: 0.8,
      maxTokens: 250
    },
    voice: {
      provider: '11labs',
      voiceId: voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID,
      model: 'eleven_turbo_v2_5',
      stability: 0.5,
      similarityBoost: 0.75,
      useSpeakerBoost: true,
      optimizeStreamingLatency: 4
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en-US',
      smartFormat: true,
      endpointing: 200
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
async function startOutboundCall({ toNumber, vapiNumberId, vapiAssistantId, metadata }) {
  if (!vapiNumberId) throw new Error('vapiNumberId is required for outbound calls')

  const payload = {
    assistantId: vapiAssistantId,
    customer: {
      number: toNumber,
      name: metadata?.leadName || ''
    },
    phoneNumberId: vapiNumberId,
    assistantOverrides: {
      variableValues: {
        prospect_name:    metadata?.leadName    || '',
        prospect_company: metadata?.leadCompany || '',
        prospect_title:   metadata?.leadTitle   || ''
      }
    },
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
