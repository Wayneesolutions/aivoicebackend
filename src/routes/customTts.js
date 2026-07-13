// src/routes/customTts.js
//
// Vapi "custom-voice" webhook endpoint. Vapi POSTs here during a call
// whenever it needs Hindi or Punjabi audio; we call Sarvam and return raw PCM bytes.
// See: docs.vapi.ai/customization/custom-voices/custom-tts
//
// SCOPE: Only wired for Hindi/Punjabi assistants (see buildVoiceConfig in vapi.js).
// English calls never reach this route — they use Vapi's native 11labs provider.
//
// AUTH: Same x-vapi-secret pattern as the main webhook in routes/webhooks.js.
// Uses VAPI_WEBHOOK_SECRET by default; set VAPI_CUSTOM_TTS_SECRET in .env
// for a separate secret if preferred.

const router = require('express').Router()
const crypto = require('crypto')
const { synthesize } = require('../services/sarvamTts')

const TTS_WEBHOOK_SECRET = process.env.VAPI_CUSTOM_TTS_SECRET || process.env.VAPI_WEBHOOK_SECRET

const SUPPORTED_LANGUAGES = new Set(['hi', 'pa'])

function verifyRequest(req) {
  if (!TTS_WEBHOOK_SECRET) return true // matches existing webhooks.js behavior when no secret configured
  const provided = req.headers['x-vapi-secret']
  if (!provided) return false
  try {
    const a = Buffer.from(provided)
    const b = Buffer.from(TTS_WEBHOOK_SECRET)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// POST /api/tts/sarvam-hindi
// Vapi request body (per Vapi Custom TTS docs):
//   { message: { type: 'voice-request', text, sampleRate, timestamp, call, assistant, customer } }
// Query params set by vapi.js buildVoiceConfig:
//   ?gender=male|female  — picks the right Sarvam speaker
//   ?language=hi|pa      — picks the right Sarvam target_language_code
router.post('/sarvam-hindi', async (req, res) => {
  const requestId = crypto.randomUUID()
  const startedAt = Date.now()

  if (!verifyRequest(req)) {
    console.error(`[SARVAM-TTS-WEBHOOK] AUTH REJECTED request=${requestId}`)
    return res.status(401).json({ error: 'Invalid webhook signature' })
  }

  const message = req.body && req.body.message
  if (!message || message.type !== 'voice-request') {
    return res.status(400).json({ error: 'Missing or invalid message.type (expected "voice-request")' })
  }

  const { text, sampleRate } = message
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing or empty text' })
  }

  const gender   = req.query.gender === 'male' ? 'male' : 'female'
  const language = SUPPORTED_LANGUAGES.has(req.query.language) ? req.query.language : 'hi'

  try {
    const pcmBuffer = await synthesize({ text, sampleRate, language, gender })

    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', pcmBuffer.length)
    res.status(200)
    res.write(pcmBuffer)
    res.end()

    console.log(
      `[SARVAM-TTS-WEBHOOK] ok request=${requestId} lang=${language} chars=${text.length} ` +
      `rate=${sampleRate}Hz gender=${gender} took=${Date.now() - startedAt}ms`
    )
  } catch (err) {
    console.error(`[SARVAM-TTS-WEBHOOK] FAILED request=${requestId} lang=${language} — ${err.message}`)
    // Non-200 triggers Vapi's fallbackPlan (ElevenLabs) instead of silent audio drop
    if (!res.headersSent) {
      res.status(500).json({ error: 'TTS synthesis failed', requestId })
    }
  }
})

module.exports = router
