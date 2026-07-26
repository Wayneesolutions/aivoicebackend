// backend/src/services/callCost.js
// Real vendor cost estimate for a completed call — NOT the client-facing billed
// amount (see billingService for that). Used purely for internal cost visibility
// (Cost dashboard). Rates are per-minute env vars so they can be updated without a
// code change as vendor pricing changes; historical calls keep whatever rate was
// in effect when they completed (computed once, stored on the Call record).
//
// AI-stack rates (Vapi, Deepgram, OpenAI, ElevenLabs/Cartesia) are the same for
// every call regardless of destination country — only the telephony leg
// (Twilio/Plivo) varies by country/provider, which is why that one comes from the
// TenantPhone record actually used for the call rather than an env var.
const VAPI_COST_PER_MINUTE       = parseFloat(process.env.VAPI_COST_PER_MINUTE || '0.05')
const DEEPGRAM_COST_PER_MINUTE   = parseFloat(process.env.DEEPGRAM_COST_PER_MINUTE || '0.0077')
const OPENAI_COST_PER_MINUTE     = parseFloat(process.env.OPENAI_COST_PER_MINUTE || '0.002')
const ELEVENLABS_COST_PER_MINUTE = parseFloat(process.env.ELEVENLABS_COST_PER_MINUTE || '0.03')
// Fallback only — set TenantPhone.telephonyCostPerMinute per number for a real number
// instead of relying on this. Defaults conservatively high so a missing rate doesn't
// silently understate cost.
const TELEPHONY_COST_PER_MINUTE_DEFAULT = parseFloat(process.env.TELEPHONY_COST_PER_MINUTE_DEFAULT || '0.05')

function estimateCallCost(durationSeconds, phoneNumber) {
  const minutes = Math.max(0, durationSeconds || 0) / 60

  const costTelephony = minutes * (phoneNumber?.telephonyCostPerMinute ?? TELEPHONY_COST_PER_MINUTE_DEFAULT)
  const costVapi       = minutes * VAPI_COST_PER_MINUTE
  const costStt        = minutes * DEEPGRAM_COST_PER_MINUTE
  const costLlm        = minutes * OPENAI_COST_PER_MINUTE
  const costTts         = minutes * ELEVENLABS_COST_PER_MINUTE
  const costTotal       = costTelephony + costVapi + costStt + costLlm + costTts

  return { costTelephony, costVapi, costStt, costLlm, costTts, costTotal }
}

module.exports = { estimateCallCost }
