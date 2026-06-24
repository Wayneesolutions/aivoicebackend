// Vapi API integration for inbound receptionist
const axios = require('axios');

const api = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
  timeout: 15000,
});

async function importPhoneNumber(phoneNumber, twilioSid) {
  const { data } = await api.post('/phone-number', {
    provider: 'twilio',
    number: phoneNumber,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  });
  return data;
}

async function deletePhoneNumber(vapiPhoneId) {
  await api.delete(`/phone-number/${vapiPhoneId}`);
}

async function linkPhoneToAssistant(vapiPhoneId, vapiAssistantId) {
  const { data } = await api.patch(`/phone-number/${vapiPhoneId}`, {
    assistantId: vapiAssistantId,
  });
  return data;
}

function buildVapiAssistantPayload(assistant) {
  const voiceConfig = assistant.voiceId || assistant.voice_id
    ? { provider: '11labs', voiceId: assistant.voiceId || assistant.voice_id }
    : { provider: '11labs', voiceId: 'EXAVITQu4vr4xnSDxMaL' };

  const lang    = assistant.language || 'en';
  const sysPrompt = assistant.systemPrompt || assistant.system_prompt || '';
  const firstMsg  = assistant.firstMessage || assistant.first_message || '';
  const transferNum  = assistant.transferNumber || assistant.transfer_number;
  const transferMsg  = assistant.transferMessage || assistant.transfer_message;
  const maxDuration  = assistant.maxCallDuration || assistant.max_call_duration || 300;

  return {
    name: `${assistant.businessName || assistant.business_name || 'Business'} — ${assistant.agentName || assistant.agent_name}`,
    firstMessage: firstMsg,
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sysPrompt }],
      temperature: 0.7,
    },
    voice: voiceConfig,
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: lang === 'en' ? 'en-CA' : 'en',
    },
    maxDurationSeconds: maxDuration,
    serverUrl: `${process.env.BASE_URL}/api/webhooks/vapi-inbound`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,
    endCallFunctionEnabled: false,
    recordingEnabled: true,
    silenceTimeoutSeconds: 30,
    responseDelaySeconds: 0.5,
    tools: transferNum ? [{
      type: 'transferCall',
      destinations: [{
        type: 'number',
        number: transferNum,
        message: transferMsg || 'Please hold, connecting you now.',
      }]
    }] : [],
  };
}

async function createAssistant(assistant) {
  const payload = buildVapiAssistantPayload(assistant);
  const { data } = await api.post('/assistant', payload);
  return data;
}

async function updateAssistant(vapiAssistantId, assistant) {
  const payload = buildVapiAssistantPayload(assistant);
  const { data } = await api.patch(`/assistant/${vapiAssistantId}`, payload);
  return data;
}

module.exports = {
  importPhoneNumber,
  deletePhoneNumber,
  linkPhoneToAssistant,
  createAssistant,
  updateAssistant,
  buildVapiAssistantPayload,
};
