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
      temperature: 0.7,
      maxTokens: 200  // keep phone responses short
    },
    voice: {
      provider: '11labs',
      voiceId: voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID,
      model: 'eleven_flash_v2_5',
      stability: 0.5,
      similarityBoost: 0.75,
      useSpeakerBoost: true,
      optimize_streaming_latency: 4
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'en-US',
      smartFormat: true,
      endpointing: 200
    },
    firstMessage: `Hi, this is ${agentName}. Am I speaking with the right person?`,
    endCallFunctionEnabled: true,
    recordingEnabled: true,
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 600,  // 10 min max per call
    backgroundSound: 'office',
    // Webhook — Vapi will POST call events here
    serverUrl: `${process.env.BASE_URL}/api/webhooks/vapi`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET
  }

  if (existingAssistantId) {
    const res = await vapiClient.patch(`/assistant/${existingAssistantId}`, payload)
    return res.data.id
  } else {
    const res = await vapiClient.post('/assistant', payload)
    return res.data.id
  }
}

/**
 * Trigger an outbound call via Vapi.
 * Returns the Vapi call object.
 */
async function startOutboundCall({ toNumber, fromNumber, vapiAssistantId, metadata }) {
  const res = await vapiClient.post('/call/phone', {
    assistantId: vapiAssistantId,
    customer: {
      number: toNumber,
      name: metadata?.leadName || ''
    },
    phoneNumber: { number: fromNumber },
    assistantOverrides: {
      // Pass lead-specific context so the AI knows who it's calling
      variableValues: {
        prospect_name: metadata?.leadName || '',
        prospect_company: metadata?.leadCompany || '',
        prospect_title: metadata?.leadTitle || ''
      }
    },
    metadata: {
      tenantId: metadata.tenantId,
      leadId: metadata.leadId,
      campaignId: metadata.campaignId
    }
  })
  return res.data
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
