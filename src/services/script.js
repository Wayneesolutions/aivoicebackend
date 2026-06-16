// backend/src/services/script.js
// Converts the client's plain-English script into a full LLM system prompt

const LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German',
  pt: 'Portuguese', ar: 'Arabic', zh: 'Mandarin Chinese', ja: 'Japanese',
  ko: 'Korean', ru: 'Russian', it: 'Italian', nl: 'Dutch', tr: 'Turkish', pl: 'Polish'
}

// Per-language style instructions — tuned for natural human speech
const LANGUAGE_STYLE = {
  hi: `━━━━ LANGUAGE STYLE (CRITICAL — READ FIRST) ━━━━
Speak in natural HINGLISH — the way educated Indians actually talk on phone calls.
This means: Hindi sentence structure and flow, but freely mix in English words wherever they feel natural.
RULES:
- Use English for: business terms (meeting, call, software, solution, team, project, budget, demo, proposal), numbers, company names, product names, tech words.
- Use Hindi for: conversational connectors (toh, aur, matlab, bas, theek hai, bilkul, suno, dekho, actually), greetings, transitions, emotions.
- Example: "Toh basically humara solution aapki team ko help karta hai apna efficiency improve karne mein."
- Example: "Aapke paas koi 15 minutes hain ek quick call ke liye?"
- NEVER use formal pure Hindi words like "उपाय", "सेवाएँ", "प्रस्तुत" — use their natural Hinglish equivalents.
- Match the prospect's language style — if they speak more English, lean more English. If more Hindi, lean more Hindi.`,

  es: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational Spanish. Use Latin American Spanish tone — warm and direct. English technical terms (software, email, meeting) are fine to keep in English.`,
  fr: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational French. Keep technical English terms as-is. Be warm and professional.`,
  de: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational German. Keep technical English terms as-is. Be direct and professional.`,
  pt: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational Brazilian Portuguese. Keep English tech terms as-is.`,
  ar: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural Modern Standard Arabic or Gulf dialect depending on context. English business terms are fine to keep.`,
  zh: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural Mandarin Chinese. English technical and business terms can stay in English.`,
  ja: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational Japanese. Use polite but friendly keigo. English tech terms are fine.`,
  ko: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational Korean. Use polite speech level. English tech/business terms are fine.`,
  ru: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational Russian. English tech and business terms can stay as-is.`,
  it: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational Italian. English tech terms are fine to keep.`,
  nl: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational Dutch. English tech terms are fine — Dutch speakers use them naturally.`,
  tr: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational Turkish. English tech and business terms can stay as-is.`,
  pl: `━━━━ LANGUAGE (CRITICAL) ━━━━\nSpeak in natural conversational Polish. English tech terms are fine to keep.`,
}

/**
 * Takes a Script record and compiles it into a production-ready system prompt.
 * This is the core magic — the client writes in plain English,
 * your system wraps it with all the AI calling rules automatically.
 */
function compileSystemPrompt(script) {
  const lang = script.language || 'en'
  const langRule = lang !== 'en' && LANGUAGE_STYLE[lang]
    ? `\n${LANGUAGE_STYLE[lang]}\n`
    : ''

  const prompt = `${langRule}
You are ${script.agentName}, making a professional outbound sales call right now.
The person you are calling is named {{prospect_name}}{{prospect_company ? " from " + prospect_company : ""}}.

━━━━ ABOUT THE COMPANY YOU REPRESENT ━━━━
${script.companyInfo}

━━━━ WHAT YOU ARE CALLING ABOUT ━━━━
${script.servicesInfo}

━━━━ YOUR GOAL ━━━━
${script.goalText}

${script.objections ? `━━━━ OBJECTION HANDLING ━━━━\n${script.objections}` : ''}

${script.faqDocument ? `━━━━ FAQ — USE THIS TO ANSWER QUESTIONS ━━━━\n${script.faqDocument}` : ''}

━━━━ HOW TO CONDUCT THIS CALL ━━━━

STYLE — this is the most important section:
- You are having a REAL phone conversation. Every reply must be 1-2 sentences MAX.
- Speak the way a confident, friendly human would — casual, warm, never robotic.
- LISTEN to what {{prospect_name}} says and respond to it directly before moving forward.
- Never read out a list. Never pitch more than one thing at a time.
- Use natural filler words: "Sure", "Absolutely", "That makes sense", "Of course".
- Pause with a question after every point you make — don't monologue.

OPENING THE CALL:
- After they confirm it's {{prospect_name}}, briefly say who you are and why you called in one sentence.
- Then ask ONE open question to get them talking. Example: "Quick question — are you currently working with any IT partners for your development projects?"
- Let them talk. The more they talk, the better.

IDENTITY:
- Your name is ${script.agentName}.
- If asked "Are you a real person?" or "Are you AI?": "I'm a voice assistant — but everything about this offer is real and a person will follow up. Want to hear a bit more?"
- Never lie if pressed, but don't volunteer it.

BOOKING A MEETING:
- When they agree to meet, immediately use the book_meeting function.
- Offer 2 specific time slots: "I have Tuesday at 2pm or Thursday at 10am — which works better?"
- Confirm: "Perfect, you're booked for [time]. You'll get a confirmation shortly."

WHEN TO END THE CALL:
- Use end_call when: meeting is booked, they clearly say no, they ask to be removed, or voicemail.
- Always end warmly: "Thanks so much for your time — have a great day!"

NEVER DO:
- Talk for more than 2 sentences without asking a question.
- Mention competitors.
- Make up prices, timelines, or promises.
- Keep going if they want to hang up.
`.trim()

  return prompt
}

/**
 * Generates the Vapi function call definitions for this agent
 * These allow the AI to book meetings, end calls, and request callbacks
 */
function getVapiFunctions() {
  const serverUrl = process.env.BASE_URL + '/api/webhooks/vapi'
  const serverSecret = process.env.VAPI_WEBHOOK_SECRET

  return [
    {
      type: 'function',
      function: {
        name: 'book_meeting',
        description: 'Book a discovery/consultation/quote meeting with the prospect. Call this as soon as the prospect agrees to meet.',
        parameters: {
          type: 'object',
          properties: {
            prospect_name:  { type: 'string', description: 'Full name of the prospect' },
            prospect_email: { type: 'string', description: 'Email address if provided (optional)' },
            preferred_slot: { type: 'string', description: 'ISO 8601 datetime the prospect chose, e.g. 2026-07-01T14:00:00Z' },
            notes:          { type: 'string', description: 'Any relevant notes from the conversation' }
          },
          required: ['prospect_name', 'preferred_slot']
        }
      },
      server: { url: serverUrl, secret: serverSecret }
    },
    {
      type: 'function',
      function: {
        name: 'request_callback',
        description: 'Schedule a callback when the prospect says they are busy or asks to be called at a different time.',
        parameters: {
          type: 'object',
          properties: {
            callback_time: { type: 'string', description: 'When to call back — natural language or ISO datetime' },
            notes:         { type: 'string', description: 'What they said — e.g. "call Tuesday morning"' }
          },
          required: ['callback_time']
        }
      },
      server: { url: serverUrl, secret: serverSecret }
    },
    {
      // Vapi built-in endCall tool — no server needed
      type: 'endCall',
      function: {
        name: 'end_call',
        description: 'End the call. Use when meeting is booked, prospect is not interested, or prospect asks to be removed from the list.',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              enum: ['BOOKED', 'NOT_INTERESTED', 'CALLBACK', 'WRONG_NUMBER', 'OPTED_OUT', 'VOICEMAIL']
            },
            summary: { type: 'string', description: 'One sentence summary of the call outcome' }
          },
          required: ['reason']
        }
      }
    }
  ]
}

module.exports = { compileSystemPrompt, getVapiFunctions, LANGUAGE_NAMES }
