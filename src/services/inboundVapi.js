// Vapi API integration for inbound receptionist
const axios = require('axios');

const api = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
  timeout: 15000,
});

async function importPhoneNumber(phoneNumber, twilioSid) {
  try {
    const accountSid = process.env.TWILIO_INBOUND_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_INBOUND_AUTH_TOKEN  || process.env.TWILIO_AUTH_TOKEN;
    const { data } = await api.post('/phone-number', {
      provider: 'twilio',
      number: phoneNumber,
      twilioAccountSid: accountSid,
      twilioAuthToken:  authToken,
    });
    return data;
  } catch (err) {
    const vapiBody = err.response?.data;
    console.error('[inboundVapi] importPhoneNumber 400 body:', JSON.stringify(vapiBody, null, 2));
    const msg = vapiBody?.message || vapiBody?.error || err.message;
    const e = new Error(`Vapi: ${msg}`);
    e.vapiError = vapiBody;
    e.statusCode = err.response?.status;
    throw e;
  }
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

const DEEPGRAM_LANG = {
  en: 'en', hi: 'hi', pa: 'hi', hinglish: 'hi',
  es: 'es', fr: 'fr', de: 'de', pt: 'pt', it: 'it',
  ko: 'ko', ja: 'ja', ru: 'ru', tr: 'tr',
};

function buildVapiAssistantPayload(assistant) {
  const lang         = assistant.language || 'en';
  const sysPrompt    = assistant.systemPrompt || assistant.system_prompt || '';
  const firstMsg     = assistant.firstMessage || assistant.first_message || '';
  const transferNum  = assistant.transferNumber || assistant.transfer_number;
  const transferMsg  = assistant.transferMessage || assistant.transfer_message;
  const maxDuration  = assistant.maxCallDuration || assistant.max_call_duration || 300;
  const voiceId      = assistant.voiceId || assistant.voice_id || 'EXAVITQu4vr4xnSDxMaL';

  const payload = {
    name: `${assistant.businessName || assistant.business_name || 'Business'} — ${assistant.agentName || assistant.agent_name}`,
    firstMessage: firstMsg,
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt: sysPrompt,
      temperature: 0.7,
      maxTokens: 150,
    },
    voice: {
      provider: '11labs',
      voiceId,
      model: 'eleven_flash_v2_5',
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: DEEPGRAM_LANG[lang] || 'en',
      smartFormat: true,
    },
    maxDurationSeconds: maxDuration,
    recordingEnabled: true,
    silenceTimeoutSeconds: 30,
    serverUrl: `${process.env.BASE_URL}/api/webhooks/vapi-inbound`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET,
  };

  if (transferNum) {
    payload.tools = [{
      type: 'transferCall',
      destinations: [{
        type: 'number',
        number: transferNum,
        message: transferMsg || 'Please hold, connecting you now.',
      }],
    }];
  }

  return payload;
}

async function createAssistant(assistant) {
  try {
    const payload = buildVapiAssistantPayload(assistant);
    const { data } = await api.post('/assistant', payload);
    return data;
  } catch (err) {
    if (err.response) console.error('[inboundVapi] createAssistant error:', err.response.status, JSON.stringify(err.response.data));
    throw err;
  }
}

async function updateAssistant(vapiAssistantId, assistant) {
  try {
    const payload = buildVapiAssistantPayload(assistant);
    const { data } = await api.patch(`/assistant/${vapiAssistantId}`, payload);
    return data;
  } catch (err) {
    if (err.response) console.error('[inboundVapi] updateAssistant error:', err.response.status, JSON.stringify(err.response.data));
    throw err;
  }
}

module.exports = {
  importPhoneNumber,
  deletePhoneNumber,
  linkPhoneToAssistant,
  createAssistant,
  updateAssistant,
  buildVapiAssistantPayload,
};
