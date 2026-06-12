// backend/src/services/script.js
// Converts the client's plain-English script into a full LLM system prompt

/**
 * Takes a Script record and compiles it into a production-ready system prompt.
 * This is the core magic — the client writes in plain English,
 * your system wraps it with all the AI calling rules automatically.
 */
function compileSystemPrompt(script) {
  const prompt = `
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

module.exports = { compileSystemPrompt, getVapiFunctions }
