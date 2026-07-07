// WhatsApp alert to business owner when an inbound call ends
const twilio = require('twilio');

async function notifyCallEnded({ callerNumber, outcome, summary, businessName, ownerWhatsapp, duration }) {
  if (!ownerWhatsapp || !process.env.TWILIO_WHATSAPP_FROM) return;

  const icon = {
    COMPLETED:   '✅',
    TRANSFERRED: '🔀',
    NO_ANSWER:   '📵',
    VOICEMAIL:   '📬',
    FAILED:      '❌',
  }[outcome] || '📞';

  const mins = Math.floor((duration || 0) / 60);
  const secs = (duration || 0) % 60;
  const durationText = duration ? `${mins}m ${secs}s` : 'unknown';

  const message =
    `${icon} *Inbound Call — ${businessName}*\n\n` +
    `📞 From: ${callerNumber || 'Unknown'}\n` +
    `⏱ Duration: ${durationText}\n` +
    `📋 Outcome: ${outcome}\n\n` +
    `💬 Summary:\n${summary || 'No summary available'}\n\n` +
    `_Powered by Quor_`;

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: ownerWhatsapp.startsWith('whatsapp:') ? ownerWhatsapp : `whatsapp:${ownerWhatsapp}`,
      body: message,
    });
  } catch (err) {
    console.error('[inboundNotification] WhatsApp failed:', err.message);
  }
}

module.exports = { notifyCallEnded };
