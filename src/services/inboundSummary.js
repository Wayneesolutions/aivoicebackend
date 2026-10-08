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

// Vapi's end-of-call-report carries the conversation twice: artifact.messages
// (an array of turns) and artifact.transcript (ONE string, "AI: …\nUser: …").
// The inbound handler used to read only artifact.transcript and then keep it
// only if it was an array — so the string was thrown away and every inbound
// call was saved with transcript: []. That left integrators (and our own
// call log) with a summary but no record of what the caller actually said,
// e.g. the WhatsApp number they dictated.
//
// Always returns an array of { role: 'assistant' | 'user', message, time? }
// so InboundCall.transcript keeps the one shape the dashboard already expects.
function normalizeTranscript(report = {}) {
  const artifact = report.artifact || report.call?.artifact || {};

  const candidates = [artifact.messages, report.messages, artifact.transcript, report.transcript];
  const turns = candidates.find((c) => Array.isArray(c) && c.length);
  if (turns) {
    return turns
      .map((m) => {
        const role = String(m.role || m.speaker || '').toLowerCase();
        const message = m.message || m.content || m.text || m.transcript;
        if (!message || typeof message !== 'string') return null;
        // system = our own prompt; tool turns = function-call plumbing
        if (role === 'system' || role.startsWith('tool') || role === 'function') return null;
        const out = { role: (role === 'user' || role === 'customer') ? 'user' : 'assistant', message: message.trim() };
        if (m.time != null) out.time = m.time;
        if (m.secondsFromStart != null) out.secondsFromStart = m.secondsFromStart;
        return out;
      })
      .filter(Boolean);
  }

  const text = [artifact.transcript, report.transcript].find((c) => typeof c === 'string' && c.trim());
  if (!text) return [];

  const parsed = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(AI|Assistant|Bot|Agent|User|Customer|Caller)\s*:\s*(.*)$/i);
    if (match) {
      const isUser = /^(user|customer|caller)$/i.test(match[1]);
      if (match[2].trim()) parsed.push({ role: isUser ? 'user' : 'assistant', message: match[2].trim() });
    } else if (line.trim() && parsed.length) {
      parsed[parsed.length - 1].message += ` ${line.trim()}`; // continuation of the previous turn
    } else if (line.trim()) {
      parsed.push({ role: 'assistant', message: line.trim() });
    }
  }
  return parsed;
}

module.exports = { extractSummaryAndOutcome, normalizeTranscript };
