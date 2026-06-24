// Extracts summary and outcome from Vapi's end-of-call-report analysis
// Vapi already runs OpenAI post-call analysis — no extra API key needed.

function extractSummaryAndOutcome({ analysis, endedReason }) {
  const summary = analysis?.summary || null;

  // Map Vapi's endedReason to our outcome tags
  const reason = (endedReason || '').toLowerCase();
  let outcome = 'COMPLETED';
  if (reason.includes('no-answer') || reason.includes('customer-did-not-answer')) outcome = 'NO_ANSWER';
  else if (reason.includes('voicemail')) outcome = 'VOICEMAIL';
  else if (reason.includes('error') || reason.includes('failed'))                  outcome = 'FAILED';
  // TRANSFERRED is set by the transfer tool during the call (already in DB)

  return { summary, outcome };
}

module.exports = { extractSummaryAndOutcome };
