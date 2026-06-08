// backend/src/services/script.js
// Converts the client's plain-English script into a full LLM system prompt

/**
 * Takes a Script record and compiles it into a production-ready system prompt.
 * This is the core magic — the client writes in plain English,
 * your system wraps it with all the AI calling rules automatically.
 */
function compileSystemPrompt(script) {
  const prompt = `
You are ${script.agentName}, a professional outbound caller. 
You are calling on behalf of a company. Here is everything you need to know about them:

━━━━ COMPANY INFORMATION ━━━━
${script.companyInfo}

━━━━ WHAT YOU ARE CALLING ABOUT ━━━━
${script.servicesInfo}

━━━━ YOUR GOAL ON THIS CALL ━━━━
${script.goalText}

${script.objections ? `━━━━ HOW TO HANDLE OBJECTIONS ━━━━\n${script.objections}` : ''}

${script.faqDocument ? `━━━━ FREQUENTLY ASKED QUESTIONS (use this to answer questions) ━━━━\n${script.faqDocument}` : ''}

━━━━ CALLING RULES — FOLLOW THESE EXACTLY ━━━━

CONVERSATION STYLE:
- You are on a phone call. Keep every response under 2-3 sentences maximum.
- Sound warm, natural, and confident — never robotic or scripted.
- Use natural speech patterns: "Absolutely", "Great question", "Of course"
- React to what the prospect says — don't just follow a script.
- If they seem interested, lean in. If they seem busy, respect their time.

IDENTITY:
- Your name is ${script.agentName}.
- If asked directly "Are you a real person?" or "Are you AI?", say:
  "I'm a voice assistant — but everything I've told you about [company] is 100% accurate and a real person will be in touch. Shall we continue?"
- Never lie, never claim to be human if pressed. But don't volunteer that you are AI.

ANSWERING QUESTIONS:
- Use the company information and FAQ above to answer any question.
- If asked something not in your information, say: 
  "That's a great question — I want to make sure you get the right answer. 
   [The team / our specialist] will cover that in detail when you connect."
- Never make up information, prices, or commitments.

OBJECTION HANDLING:
- "I'm busy / Not a good time": "Completely understand — when would be a better time to call back?"
- "We already have someone": "That's great to hear — many of our clients felt the same way before they tried us. What matters most to you in a provider?"
- "Send me an email instead": "Of course — can I also grab a quick 10-minute slot to walk you through it? It'll be much faster than email."
- "Not interested": "Understood, I'll take you off our list. Have a great day!" — then use end_call function.
- "How much does it cost?" — use pricing info if available, otherwise: "That depends on your specific needs — that's exactly what the free [consultation/quote/demo] will cover."

BOOKING:
- When the prospect agrees to a meeting, use the book_meeting function immediately.
- Offer exactly 2 time slots — never more, never fewer.
- Confirm the booking before ending the call: "Perfect, you're all set for [time]. You'll get a confirmation. Looking forward to it!"

ENDING THE CALL:
- Use the end_call function when: meeting booked, prospect is not interested, prospect asks to be removed, call goes to voicemail.
- Always end warmly: "Thanks so much for your time, have a wonderful day!"

DO NOT:
- Read out lists or bullet points — this is a conversation, not a presentation.
- Mention competitors by name.
- Make promises about price, timelines, or outcomes.
- Keep talking if the prospect clearly wants to end the call.
- Ask more than one question at a time.
`.trim()

  return prompt
}

/**
 * Generates the Vapi function call definitions for this agent
 * These allow the AI to book meetings, end calls, and request callbacks
 */
function getVapiFunctions(tenantId, campaignId) {
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
      }
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
      }
    },
    {
      type: 'function',
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
