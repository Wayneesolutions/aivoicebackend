// src/services/sarvamTts.js
//
// Sarvam AI (Bulbul v3) TTS wrapper — used for Hindi AND Punjabi calls.
// English stays on ElevenLabs via vapi.js; this file is never called for it.
//
// Integration pattern: Vapi "custom-voice" webhook. Vapi calls our
// /api/tts/sarvam-hindi endpoint (customTts.js) with the text to speak;
// that route calls this module; we return raw PCM bytes in exactly the
// format Vapi requires (16-bit signed PCM, little-endian, mono).
// Sarvam's output_audio_codec="linear16" returns headerless raw PCM — no re-encoding needed.

const axios = require('axios')

const SARVAM_API_URL = process.env.SARVAM_API_URL || 'https://api.sarvam.ai/text-to-speech'
const SARVAM_API_KEY = process.env.SARVAM_API_KEY

// Vapi only ever asks for one of these — Sarvam v3 supports all of them.
const VAPI_ALLOWED_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000])

// Our language code → Sarvam target_language_code
const LANG_TO_TARGET_CODE = {
  hi: 'hi-IN',
  pa: 'pa-IN',
}

// Per-language speaker voices — override via .env to try different ones from dashboard.sarvam.ai.
// Bulbul v3 speakers (meera, arjun, etc.) are multilingual and work across Hindi and Punjabi.
// Valid speakers as of Sarvam Bulbul v3 (July 2026):
// anushka, abhilash, manisha, vidya, arya, karun, hitesh, aditya, ritu, priya,
// neha, rahul, pooja, rohan, simran, kavya, amit, dev, ishita, shreya, ratan,
// varun, manan, sumit, roopa, kabir, aayan, shubh, ashutosh, advait, anand,
// tanya, tarun, sunny, mani, gokul, vijay, shruti, suhani, mohit, kavitha, rehan, soham, rupali
// Valid speakers as of Sarvam Bulbul v3 (July 2026):
// aditya, ritu, ashutosh, priya, neha, rahul, pooja, rohan, simran, kavya,
// amit, dev, ishita, shreya, ratan, varun, manan, sumit, roopa, kabir, aayan,
// shubh, advait, anand, tanya, tarun, sunny, mani, gokul, vijay, shruti,
// suhani, mohit, kavitha, rehan, soham, rupali, niharika
const SPEAKERS = {
  hi: {
    female: process.env.SARVAM_HINDI_VOICE_FEMALE   || 'priya',
    male:   process.env.SARVAM_HINDI_VOICE_MALE     || 'rahul',
  },
  pa: {
    female: process.env.SARVAM_PUNJABI_VOICE_FEMALE || 'priya',
    male:   process.env.SARVAM_PUNJABI_VOICE_MALE   || 'rahul',
  },
}

function resolveSpeaker(language, gender) {
  const lang = SPEAKERS[language] || SPEAKERS.hi
  return gender === 'male' ? lang.male : lang.female
}

const sarvamClient = axios.create({
  baseURL: SARVAM_API_URL,
  timeout: 15000, // well under Vapi's configured timeoutSeconds (20s in vapi.js)
  headers: {
    'api-subscription-key': SARVAM_API_KEY,
    'Content-Type': 'application/json',
  },
})

/**
 * Synthesize Hindi or Punjabi speech via Sarvam Bulbul v3.
 * Returns raw 16-bit PCM (little-endian, mono) ready to hand to Vapi.
 *
 * @param {Object} opts
 * @param {string} opts.text          - Text to speak
 * @param {number} opts.sampleRate    - Sample rate Vapi requested
 * @param {'hi'|'pa'} [opts.language] - Language code (defaults to 'hi')
 * @param {'male'|'female'} [opts.gender]
 * @returns {Promise<Buffer>}
 */
async function synthesize({ text, sampleRate, language = 'hi', gender }) {
  if (!SARVAM_API_KEY) {
    throw new Error('SARVAM_API_KEY is not set — add it to .env before enabling Sarvam TTS')
  }
  if (!text || !text.trim()) {
    throw new Error('sarvamTts.synthesize called with empty text')
  }
  if (!VAPI_ALLOWED_SAMPLE_RATES.has(sampleRate)) {
    console.warn(`[SARVAM TTS] Unexpected sampleRate=${sampleRate}, defaulting to 24000`)
    sampleRate = 24000
  }

  const targetLangCode = LANG_TO_TARGET_CODE[language] || 'hi-IN'

  // Sarvam v3 caps at 2500 chars per request — trim defensively rather than let the API 422 mid-call.
  const safeText = text.length > 2500 ? text.slice(0, 2500) : text

  const speaker = resolveSpeaker(language, gender)

  const body = {
    text: safeText,
    target_language_code: targetLangCode,
    model: 'bulbul:v3',
    speaker,
    pace: 1.0,
    speech_sample_rate: sampleRate,
    output_audio_codec: 'linear16', // headerless raw PCM — matches Vapi's requirement exactly
    enable_preprocessing: true,      // normalizes numbers/code-switching per Sarvam docs
  }

  const startedAt = Date.now()
  try {
    const res = await sarvamClient.post('', body)
    const base64Audio = res.data && res.data.audios && res.data.audios[0]
    if (!base64Audio) {
      throw new Error('Sarvam TTS response missing audios[0]')
    }
    const pcmBuffer = Buffer.from(base64Audio, 'base64')
    console.log(
      `[SARVAM TTS] ok — lang=${language}(${targetLangCode}) speaker=${speaker} ` +
      `rate=${sampleRate}Hz chars=${safeText.length} bytes=${pcmBuffer.length} took=${Date.now() - startedAt}ms`
    )
    return pcmBuffer
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message
    console.error(`[SARVAM TTS ERROR] lang=${language} speaker=${speaker} rate=${sampleRate}Hz — ${detail}`)
    throw err
  }
}

module.exports = { synthesize }
