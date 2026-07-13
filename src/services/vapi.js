// ============================================================
// FIX-09 — backend/src/services/vapi.js (Pankaj review, June 19/20)
// ROOT CAUSE OF THE ACCENT-SWITCHING BUG FOUND:
//
//   On a live test call, the agent opened in English (American accent)
//   then switched to pure Hindi accent mid-call. Two separate bugs
//   combined to cause this:
//
//   BUG-D (hardcoded English greeting):
//     firstMessage was a hardcoded English string regardless of the
//     script's configured language. Every call — even ones set to
//     Hindi — opened in English. FIXED: firstMessage is now
//     built per-language.
//
//   BUG-E (no language-aware voice selection):
//     The SAME ElevenLabs voiceId was used for English and Hindi
//     calls with no validation that the voice is actually good at both.
//     If voiceId is an English-tuned voice, ElevenLabs renders Hindi
//     text in a flat, mismatched accent. FIXED: language is now passed
//     through to the voice config, and we warn loudly if a tenant's
//     chosen voice hasn't been confirmed multilingual-capable.
//
//   NOTE ON LATENCY: eleven_flash_v2_5 is correct for low latency, but
//   per ElevenLabs' own docs, persona/accent consistency across a
//   language switch depends on using a voice actually trained for that
//   language pair. The ELEVENLABS_DEFAULT_VOICE_ID in your .env MUST be
//   a voice confirmed multilingual (check ElevenLabs Voice Library →
//   filter "multilingual" or your cloned voice, which inherits
//   multilingual capability automatically).
// ============================================================

const axios = require('axios')
const { getVapiFunctions } = require('./script')

// Map our language codes to Deepgram language codes
const DEEPGRAM_LANG = {
  en:      'en-US',
  hi:      'hi',
  pa:      'hi',      // Punjabi — closest supported
  es: 'es', fr: 'fr', de: 'de', pt: 'pt', ar: 'ar',
  zh: 'zh-CN', ja: 'ja', ko: 'ko', ru: 'ru',
  it: 'it', nl: 'nl', tr: 'tr', pl: 'pl'
}

// FIX BUG-D: language-appropriate + gender-correct opening lines.
// {{prospect_name}} is a template var Vapi fills at call time.
// Hindi/Punjabi verb forms differ by gender: "bol raha hoon" (male) vs "bol rahi hoon" (female).
const FIRST_MESSAGE_BY_LANG = {
  en: 'Hi, this is {{agent_name}} calling.',
  hi: {
    male:   'नमस्ते! मैं {{agent_name}} बोल रहा हूँ।',
    female: 'नमस्ते! मैं {{agent_name}} बोल रही हूँ।'
  },
  pa: {
    male:   'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ {{agent_name}} ਬੋਲ ਰਿਹਾ ਹਾਂ।',
    female: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ {{agent_name}} ਬੋਲ ਰਹੀ ਹਾਂ।'
  }
}

function buildFirstMessage(language, agentName, gender) {
  const entry = FIRST_MESSAGE_BY_LANG[language] || FIRST_MESSAGE_BY_LANG.en
  const g = gender === 'male' ? 'male' : 'female'
  // English is a plain string; Hindi/Punjabi are gender-keyed objects
  const template = typeof entry === 'string' ? entry : (entry[g] || entry.female)
  return template.replace('{{agent_name}}', agentName)
}

// Prepend gender instruction to system prompt so the AI uses the right verb forms
// throughout the call — not just the opening line.
function buildGenderInstruction(language, gender) {
  const g = gender === 'male' ? 'male' : 'female'
  if (language === 'hi') {
    return g === 'female'
      ? 'GENDER RULE: You are a female AI agent. Always use feminine Hindi verb forms throughout the call — "kar rahi hoon", "baat kar rahi hoon", "dekh rahi hoon", "samajh rahi hoon". Never use masculine forms like "raha hoon".\n\n'
      : 'GENDER RULE: You are a male AI agent. Always use masculine Hindi verb forms throughout the call — "kar raha hoon", "baat kar raha hoon", "dekh raha hoon", "samajh raha hoon". Never use feminine forms like "rahi hoon".\n\n'
  }
  if (language === 'pa') {
    return g === 'female'
      ? 'GENDER RULE: You are a female AI agent. Always use feminine Punjabi verb forms — "kar rahi haan", "bol rahi haan". Never use masculine forms like "riha haan".\n\n'
      : 'GENDER RULE: You are a male AI agent. Always use masculine Punjabi verb forms — "kar riha haan", "bol riha haan". Never use feminine forms like "rahi haan".\n\n'
  }
  return '' // English — no gendered verb forms needed
}

function buildLanguageInstruction(language) {
  if (language === 'hi') {
    return 'LANGUAGE RULE: You must respond ONLY in Hindi throughout the entire call. Never mix in Punjabi words or phrases. Hinglish (Hindi + occasional English technical terms) is acceptable, but Punjabi is strictly forbidden.\n\n'
  }
  if (language === 'pa') {
    return 'LANGUAGE RULE: You must respond ONLY in Punjabi throughout the entire call. Never mix in Hindi words or phrases. Use natural conversational Punjabi only.\n\n'
  }
  return ''
}

const vapiClient = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }
})

const VAPI_BUILTIN_VOICE = '21m00Tcm4TlvDq8ikWAM'

// Known ElevenLabs voice IDs confirmed multilingual (includes Hindi).
// Not exhaustive — just a sanity-check allowlist. If your configured
// voice isn't in here, we don't block the call but warn loudly so
// the mismatch gets caught before a client call, not during one.
const KNOWN_MULTILINGUAL_VOICES = new Set([
  process.env.ELEVENLABS_DEFAULT_VOICE_ID,
  process.env.ELEVENLABS_HINDI_VOICE_ID,
].filter(Boolean))

function warnIfVoiceLanguageMismatch({ voiceId, language }) {
  const needsMultilingual = language && language !== 'en'
  if (needsMultilingual && voiceId && !KNOWN_MULTILINGUAL_VOICES.has(voiceId)) {
    console.warn(
      `[VAPI] ⚠️  WARNING: language="${language}" call is using voiceId="${voiceId}" which is ` +
      `NOT in the confirmed-multilingual list. If this voice was tuned for English, ` +
      `Hindi speech will likely sound mismatched. ` +
      `Fix: confirm this voice in ElevenLabs Voice Library supports Hindi, or set ` +
      `ELEVENLABS_HINDI_VOICE_ID in .env to a multilingual-confirmed voice.`
    )
  }
}

// ── SARVAM TTS INTEGRATION ─────────────────────────────────────────────
// Hindi calls route to Sarvam Bulbul v3 via Vapi's custom-voice webhook
// pattern when SARVAM_TTS_ENABLED=true. English/Punjabi are untouched.
// Flip SARVAM_TTS_ENABLED=false to instantly revert to ElevenLabs for Hindi
// with no code change — safe rollback at any time.
const SARVAM_TTS_ENABLED   = process.env.SARVAM_TTS_ENABLED === 'true'
const SARVAM_TTS_LANGUAGES = new Set(['hi', 'pa'])

function shouldUseSarvam(language) {
  return SARVAM_TTS_ENABLED && SARVAM_TTS_LANGUAGES.has(language)
}

/**
 * Builds the voice block for a Vapi assistant payload.
 * - Hindi (SARVAM_TTS_ENABLED=true): routes to our Sarvam custom-TTS webhook,
 *   with ElevenLabs as automatic fallback if Sarvam errors or times out.
 * - All other languages: unchanged ElevenLabs config.
 */
function buildVoiceConfig({ voiceId, language, agentGender }) {
  if (shouldUseSarvam(language)) {
    const gender = agentGender === 'male' ? 'male' : 'female'
    console.log(`[VAPI] language="${language}" → routing TTS to Sarvam (gender=${gender})`)
    return {
      provider: 'custom-voice',
      server: {
        // gender as query param so the webhook picks the right Sarvam speaker
        // without a DB lookup on every TTS chunk
        url: `${process.env.BASE_URL}/api/tts/sarvam-hindi?gender=${gender}&language=${language}`,
        secret: process.env.VAPI_CUSTOM_TTS_SECRET || process.env.VAPI_WEBHOOK_SECRET,
        timeoutSeconds: 20,
      },
      fallbackPlan: {
        voices: [
          {
            provider: '11labs',
            voiceId: process.env.ELEVENLABS_HINDI_VOICE_ID || process.env.ELEVENLABS_DEFAULT_VOICE_ID,
            model: 'eleven_flash_v2_5',
          },
        ],
      },
    }
  }

  // Non-Hindi path — ElevenLabs, unchanged from before.
  warnIfVoiceLanguageMismatch({ voiceId, language })
  return {
    provider: '11labs',
    voiceId,
    model: 'eleven_flash_v2_5',
    stability: 0.5,
    similarityBoost: 0.75,
    useSpeakerBoost: true,
    optimizeStreamingLatency: 4,
    ...(process.env.VAPI_ELEVENLABS_CREDENTIAL_ID
      ? { credentialId: process.env.VAPI_ELEVENLABS_CREDENTIAL_ID }
      : {}),
  }
}
// ───────────────────────────────────────────────────────────────────────

/**
 * Create or update a Vapi assistant for a given script.
 */
async function upsertAssistant({ name, systemPrompt, voiceId, agentName, language, agentGender, existingAssistantId, maxCallDuration }) {

  const deepgramLang = DEEPGRAM_LANG[language || 'en'] || 'en-US'
  const transcriberExtra = {}

  // LiveKit smart endpointing is English-only per Vapi docs.
  // All other languages use transcription endpointing with a reduced no-punctuation wait
  // (0.8s vs the 1.5s default) — this is the main latency fix for Hindi/Punjabi.
  const isEnglish = !language || language === 'en'
  const startSpeakingPlan = isEnglish
    ? {
        waitSeconds: 0.2,
        smartEndpointingPlan: {
          provider: 'livekit',
          waitFunction: '2000 / (1 + exp(-10 * (x - 0.5)))',
        },
      }
    : {
        waitSeconds: 0.2,
        transcriptionEndpointingPlan: {
          onPunctuationSeconds:   0.1,
          onNoPunctuationSeconds: 0.4,
          onNumberSeconds:        0.3,
        },
      }

  const stopSpeakingPlan = {
    numWords:       0,
    voiceSeconds:   0.2,
    backoffSeconds: 0.4,
  }

  const resolvedVoiceId = (voiceId && voiceId !== VAPI_BUILTIN_VOICE)
    ? voiceId
    : process.env.ELEVENLABS_DEFAULT_VOICE_ID

  const genderInstruction   = buildGenderInstruction(language, agentGender)
  const languageInstruction = buildLanguageInstruction(language)

  const payload = {
    name,
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt: genderInstruction + languageInstruction + (systemPrompt || ''),
      tools: getVapiFunctions(),
      temperature: 0.6,
      maxTokens: 150,
    },
    // Hindi → Sarvam (when SARVAM_TTS_ENABLED=true), everything else → ElevenLabs.
    voice: buildVoiceConfig({ voiceId: resolvedVoiceId, language, agentGender }),
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: deepgramLang,
      smartFormat: true,
      endpointing: 300,
      ...transcriberExtra,
    },
    // FIX BUG-D: was hardcoded English. Now matches the script's language and agent gender.
    firstMessage: buildFirstMessage(language, agentName, agentGender),
    startSpeakingPlan,
    stopSpeakingPlan,
    recordingEnabled: true,
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: maxCallDuration || 180,
    backgroundSound: 'office',
    serverUrl: `${process.env.BASE_URL}/api/webhooks/vapi`,
    serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET
  }

  console.log('[VAPI] upsertAssistant lang =', language, '| deepgramLang =', deepgramLang, '| voiceId =', resolvedVoiceId, '| firstMessage =', payload.firstMessage)
  try {
    if (existingAssistantId) {
      try {
        const res = await vapiClient.patch(`/assistant/${existingAssistantId}`, payload)
        return res.data.id
      } catch (patchErr) {
        // Assistant doesn't exist in this Vapi account (e.g. after account switch) — create fresh
        if (patchErr.response?.status === 404) {
          console.warn(`[VAPI] Assistant ${existingAssistantId} not found (404) — creating new one`)
          const res = await vapiClient.post('/assistant', payload)
          return res.data.id
        }
        throw patchErr
      }
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
async function startOutboundCall({ toNumber, vapiNumberId, vapiAssistantId, metadata, voiceOverrideId, systemPromptOverride, language, agentGender }) {
  if (!vapiNumberId) throw new Error('vapiNumberId is required for outbound calls')

  const assistantOverrides = {
    variableValues: {
      prospect_name:    metadata?.leadName    || '',
      prospect_company: metadata?.leadCompany || '',
      prospect_title:   metadata?.leadTitle   || ''
    }
  }

  if (shouldUseSarvam(language)) {
    // Hindi always routes to Sarvam regardless of any ElevenLabs voiceOverrideId —
    // an English voice override is meaningless for a Hindi call.
    assistantOverrides.voice = buildVoiceConfig({ voiceId: voiceOverrideId, language, agentGender })
  } else if (voiceOverrideId) {
    warnIfVoiceLanguageMismatch({ voiceId: voiceOverrideId, language })
    assistantOverrides.voice = {
      provider: '11labs',
      voiceId: voiceOverrideId,
      model: 'eleven_flash_v2_5',
      stability: 0.5,
      similarityBoost: 0.75,
      useSpeakerBoost: true,
    }
  }

  if (systemPromptOverride) {
    const genderInstruction   = buildGenderInstruction(language, agentGender)
    const languageInstruction = buildLanguageInstruction(language)
    assistantOverrides.model = { provider: 'openai', model: 'gpt-4o-mini', systemPrompt: genderInstruction + languageInstruction + systemPromptOverride }
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
      tenantId:   metadata.tenantId,
      leadId:     metadata.leadId,
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
