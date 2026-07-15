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

// Survey calls: just a greeting with no name — the LLM's first response
// delivers the full intro (name + org + purpose + permission ask) in one shot.
const SURVEY_FIRST_MESSAGE_BY_LANG = {
  en: 'Hello!',
  hi: 'नमस्ते!',
  pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ!'
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

// ── CARTESIA TTS INTEGRATION ───────────────────────────────────────────
// Hindi/Punjabi calls route to Cartesia Sonic (sonic-3.5 by default) via
// Vapi's NATIVE cartesia provider when CARTESIA_TTS_ENABLED=true. Unlike
// the old Sarvam integration, this is NOT a custom-voice webhook bridge —
// Cartesia is a first-class Vapi voice provider, so Vapi talks to it
// directly over its own low-latency streaming connection. No extra hop,
// no webhook to host, no timeoutSeconds/fallback-on-500 plumbing needed
// on our side beyond the standard Vapi fallbackPlan.
//
// Flip CARTESIA_TTS_ENABLED=false to instantly revert to ElevenLabs for
// Hindi/Punjabi with no code change — safe rollback at any time.
//
// Prereq: the Cartesia API key must be added once under Vapi Dashboard →
// Provider Keys (or passed as credentialId below) before this works —
// Vapi needs its own credential to call Cartesia on our behalf.
const CARTESIA_TTS_ENABLED   = process.env.CARTESIA_TTS_ENABLED === 'true'
const CARTESIA_TTS_LANGUAGES = new Set(['hi', 'pa'])
const CARTESIA_MODEL         = process.env.CARTESIA_MODEL || 'sonic-3.5'

function shouldUseCartesia(language) {
  return CARTESIA_TTS_ENABLED && CARTESIA_TTS_LANGUAGES.has(language)
}

// Per-language, per-gender Cartesia voice IDs — set these in .env after
// picking voices from Cartesia's Voice Library (play.cartesia.ai) for
// Hindi and Punjabi specifically.
function resolveCartesiaVoiceId(language, gender) {
  const g = gender === 'male' ? 'MALE' : 'FEMALE'
  const key = `CARTESIA_${(language || 'hi').toUpperCase()}_VOICE_${g}`
  return process.env[key] || process.env.CARTESIA_DEFAULT_VOICE_ID
}

/**
 * Builds the voice block for a Vapi assistant payload.
 * - Hindi/Punjabi (CARTESIA_TTS_ENABLED=true): routes to Cartesia Sonic,
 *   Vapi's native low-latency provider, with ElevenLabs as automatic
 *   fallback if Cartesia errors or times out.
 * - All other languages: unchanged ElevenLabs config.
 */
function buildVoiceConfig({ voiceId, language, agentGender }) {
  if (shouldUseCartesia(language)) {
    const gender = agentGender === 'male' ? 'male' : 'female'
    const cartesiaVoiceId = resolveCartesiaVoiceId(language, gender)
    console.log(`[VAPI] language="${language}" → routing TTS to Cartesia ${CARTESIA_MODEL} (gender=${gender})`)
    if (!cartesiaVoiceId) {
      console.warn(
        `[VAPI] ⚠️  WARNING: CARTESIA_TTS_ENABLED=true but no voiceId configured for ` +
        `language="${language}" gender="${gender}". Set CARTESIA_${language.toUpperCase()}_VOICE_${gender.toUpperCase()} ` +
        `or CARTESIA_DEFAULT_VOICE_ID in .env, or this call will fail over to the ElevenLabs fallback every time.`
      )
    }
    return {
      provider: 'cartesia',
      model: CARTESIA_MODEL,
      voiceId: cartesiaVoiceId,
      language, // 'hi' or 'pa' — Cartesia's language param, improves pronunciation accuracy over auto-detect
      ...(process.env.VAPI_CARTESIA_CREDENTIAL_ID
        ? { credentialId: process.env.VAPI_CARTESIA_CREDENTIAL_ID }
        : {}),
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

  // Non-Hindi/Punjabi path — ElevenLabs, unchanged from before.
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
async function upsertAssistant({ name, systemPrompt, voiceId, agentName, language, agentGender, existingAssistantId, maxCallDuration, callType, firstMessageOverride }) {

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
        waitSeconds: 0.1,
        transcriptionEndpointingPlan: {
          onPunctuationSeconds:   0.1,
          onNoPunctuationSeconds: 0.45,
          onNumberSeconds:        0.2,
        },
      }

  const stopSpeakingPlan = {
    numWords:       0,
    voiceSeconds:   0.4,  // 0.2 was too sensitive — phone crackle / breathing triggered it
    backoffSeconds: 0.8,  // 0.4 was too short — AI restarted while human still speaking
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
      tools: getVapiFunctions(callType),
      temperature: 0.4,
      maxTokens: 150,
    },
    // Hindi/Punjabi → Cartesia (when CARTESIA_TTS_ENABLED=true), everything else → ElevenLabs.
    voice: buildVoiceConfig({ voiceId: resolvedVoiceId, language, agentGender }),
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: deepgramLang,
      // smartFormat adds punctuation — great for English but causes false early triggers
      // for Hindi/Punjabi (onPunctuationSeconds: 0.1 fires on incorrect punctuation → AI interrupts)
      smartFormat: isEnglish,
      // Hindi/Punjabi speakers have longer natural mid-sentence pauses — give more buffer
      endpointing: isEnglish ? 200 : 250,
      ...transcriberExtra,
    },
    firstMessage: firstMessageOverride || buildFirstMessage(language, agentName, agentGender),
    firstMessageMode: 'assistant-speaks-first',
    startSpeakingPlan,
    stopSpeakingPlan,
    recordingEnabled: true,
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: maxCallDuration || 180,
    backgroundDenoisingEnabled: true,  // clean the human's mic input — removed 'office' sound which confused VAD
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
async function startOutboundCall({ toNumber, vapiNumberId, vapiAssistantId, metadata, voiceOverrideId, systemPromptOverride, firstMessageOverride, language, agentGender }) {
  if (!vapiNumberId) throw new Error('vapiNumberId is required for outbound calls')

  const assistantOverrides = {
    variableValues: {
      prospect_name:    metadata?.leadName    || '',
      prospect_company: metadata?.leadCompany || '',
      prospect_title:   metadata?.leadTitle   || ''
    }
  }

  if (shouldUseCartesia(language)) {
    // Hindi/Punjabi always route to Cartesia regardless of any ElevenLabs voiceOverrideId —
    // an English voice override is meaningless for a Hindi/Punjabi call.
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

  if (firstMessageOverride) {
    assistantOverrides.firstMessage = firstMessageOverride
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
