// ============================================================
// FIX-02 — backend/src/services/script.js
// REPLACE your entire existing script.js with this file.
//
// WHAT CHANGED:
//   1. System prompt trimmed from ~800 tokens → ~380 tokens
//      (every token the LLM reads costs time before first word)
//   2. Removed all ━━━ decorative separators (wasted tokens)
//   3. Language instructions compressed to essentials only
//   4. Added detect_sentiment function — AI reports prospect mood mid-call
//      (this enables the live sentiment dashboard in FIX-05)
// ============================================================

const LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi', hinglish: 'Hinglish', pa: 'Punjabi',
  es: 'Spanish', fr: 'French', de: 'German',
  pt: 'Portuguese', ar: 'Arabic', zh: 'Mandarin Chinese', ja: 'Japanese',
  ko: 'Korean', ru: 'Russian', it: 'Italian', nl: 'Dutch', tr: 'Turkish', pl: 'Polish'
}

// Compressed language instructions — same meaning, 60% fewer tokens
const LANGUAGE_STYLE = {
  // Fix 4 from Voice Tuning Brief: "too-pure Hindi" was caused by telling the model to avoid English.
  // Hindi callers in Punjab/North India speak Hinglish naturally — mixing Hindi and English.
  // The PDF's forbidden-words list, number rules, and few-shot examples are all included here.
  hi: `LANGUAGE & TONE: Speak natural everyday Hinglish the way people in Punjab / North India actually talk on the phone — casual and friendly, like a local receptionist. NOT formal, NOT literary, NOT a news anchor.
- Mix common English words naturally: appointment, book, time, slot, confirm, number, address, cancel, sir/ma'am, sorry, thank you, ok.
- FORBIDDEN formal/Sanskritized words: suniscit, bhent, doorbhash, krmank, upalabdh — always use the Hinglish word instead.
- Write English loanwords in Devanagari so the voice reads them with a natural Indian accent: अपॉइंटमेंट, कन्फ़र्म, टाइम, स्लॉट, सॉरी, थेंक यू.

NUMBERS (critical — TTS reads raw digits incorrectly):
- Never write raw digits. Always spell out as spoken Hindi words.
- Phone numbers: digit by digit — 98146 → "नौ, आठ, एक, चार, छह"
- Times: spoken form — "साढ़े तीन बजे", "शाम के चार बजे" — never "3:30 PM"

EXAMPLES — always match the right column:
- Greeting: नमस्ते! मैं आपकी कैसे हेल्प कर सकती हूँ? [NOT: नमस्ते, मैं आपकी क्या सहायता कर सकती हूँ?]
- Ask phone: ज़रा अपना फ़ोन नंबर बता दीजिए। [NOT: कृपया अपना दूरभाष क्रमांक प्रदान करें।]
- Confirm booking: आपका अपॉइंटमेंट फ़िक्स हो गया है! [NOT: आपकी भेंट सुनिश्चित कर दी गई है।]
- Slot not free: सॉरी, उस टाइम पे हम अवेलेबल नहीं हैं। कोई और टाइम चलेगा? [NOT: क्षमा करें, उस समय हम उपलब्ध नहीं हैं।]
- Closing: ठीक है, थेंक यू! आपका दिन अच्छा रहे। [NOT: आपका दिन शुभ हो। धन्यवाद।]`,

  hinglish: `LANGUAGE: Speak natural Hinglish (Hindi structure, English business words freely mixed).
Use English for: meeting, call, software, solution, budget, demo, team, project.
Use Hindi for: toh, aur, bas, theek hai, bilkul, suno, dekho, greetings, transitions.
Example: "Toh basically humara solution aapki team ki efficiency improve karta hai."
Match the prospect — more English if they speak English, more Hindi if they speak Hindi.`,

  pa: `LANGUAGE: Speak warm conversational Punjabi. Mix English for business/tech terms naturally.
Example: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਕੀ ਮੈਂ [prospect] ਜੀ ਨਾਲ ਗੱਲ ਕਰ ਸਕਦਾ ਹਾਂ? ਸਾਡਾ solution ਤੁਹਾਡੇ business ਲਈ ਵਧੀਆ ਹੈ।"

NUMBERS (critical — TTS reads raw digits incorrectly):
- Never write raw digits. Spell out as spoken Punjabi words.
- Phone numbers: digit by digit — 98146 → "nau, ath, ik, char, chhe"
- Times: spoken form — "sadhe tin waje", "sham de char waje" — never "3:30 PM"`,

  es: `LANGUAGE: Speak natural Latin American Spanish. English tech terms are fine.`,
  fr: `LANGUAGE: Speak natural French. Keep English technical terms as-is.`,
  de: `LANGUAGE: Speak natural German. Keep English technical terms as-is.`,
  pt: `LANGUAGE: Speak natural Brazilian Portuguese. English tech terms are fine.`,
  ar: `LANGUAGE: Speak natural Modern Standard Arabic or Gulf dialect. English business terms are fine.`,
  zh: `LANGUAGE: Speak natural Mandarin Chinese. English technical terms are fine.`,
  ja: `LANGUAGE: Speak natural polite Japanese. English tech terms are fine.`,
  ko: `LANGUAGE: Speak natural polite Korean. English business terms are fine.`,
  ru: `LANGUAGE: Speak natural Russian. English tech terms are fine.`,
  it: `LANGUAGE: Speak natural Italian. English tech terms are fine.`,
  nl: `LANGUAGE: Speak natural Dutch. English tech terms are fine.`,
  tr: `LANGUAGE: Speak natural Turkish. English business terms are fine.`,
  pl: `LANGUAGE: Speak natural Polish. English tech terms are fine.`,
}

// ── SURVEY / POLLING MODE ───────────────────────────────────────────────
// Used when script.callType === 'survey' — for election polling, voter
// feedback, market research, and other neutral data-collection calls.
// This is a DIFFERENT mode from the default sales prompt below: no
// objections, no booking, no persuasion — strictly neutral Q&A.
const SURVEY_STYLE = {
  hi: `LANGUAGE & TONE: Speak natural, everyday Indian Hindi and Hinglish — like a professional research representative, not a news anchor or textbook.
Do NOT use overly formal, literary, or pure/Sanskritized Hindi. Mix in common English words the way people actually speak.
- Say "question" instead of "प्रश्न"
- Say "answer" instead of "उत्तर"
- Say "data" instead of "आंकड़े" when natural
- Say "survey" instead of formal Hindi alternatives
- Say "feedback" instead of overly formal Hindi words
- Say "area" instead of "क्षेत्र" when natural
Match the person's own style — if they speak Hinglish, reply in Hinglish.`,

  pa: `LANGUAGE & TONE: Speak natural conversational Punjabi mixed with commonly used Hindi and English words — like a professional research representative, not formal or literary.
Match the person's own style — if they speak Punjabi-English, reply in Punjabi-English.`,
}

const SURVEY_BASE_RULES = `You are __AGENT_NAME__, conducting a neutral survey call right now with {{prospect_name}}.
This is polling / data research — NOT a sales call. You are not trying to persuade, convince, or sell anything.

CRITICAL NEUTRALITY RULES (never break these):
- Do NOT influence, persuade, or guide the person's opinion in any way — political, personal, or otherwise.
- Do NOT react with approval or disapproval to any answer they give. Stay neutral no matter what they say.
- Never suggest what the "right" or "expected" answer might be.
- Maintain a neutral, professional, courteous tone throughout, like a research representative conducting election polling, surveys, voter feedback collection, or data research.

CONVERSATION RULES:
- Ask ONE question at a time. Wait for the person to fully finish their response before moving to the next question.
- Keep responses short, clear, and conversational — 1–2 sentences max between questions.
- Always acknowledge their answer briefly and neutrally ("Got it, thank you." / "Okay, noted.") before asking the next question — never comment on the content of the answer itself.
- If they ask "Are you AI?": answer honestly and briefly, then continue with the survey.
- If they decline to answer a question, thank them and move to the next one — never pressure them to answer.
- If they want to stop the survey entirely, thank them for their time and use end_call with reason REFUSED.
- Use record_response after each answered question to log it, then continue to the next question.
- Use end_call when all questions are done (COMPLETED), the person refuses to continue (REFUSED), it's a wrong number (WRONG_NUMBER), or voicemail (VOICEMAIL).`

/**
 * Builds the system prompt for a neutral survey/polling script.
 * Separate from the default sales prompt — no objections, no booking,
 * no persuasion language, no sentiment/buying-intent detection.
 */
function compileSurveySystemPrompt(script) {
  const lang = script.language || 'en'
  const styleRule = SURVEY_STYLE[lang] ? `${SURVEY_STYLE[lang]}\n\n` : ''

  const prompt = `${styleRule}${SURVEY_BASE_RULES.replace('__AGENT_NAME__', script.agentName)}

ORGANIZATION: ${script.companyInfo}

SURVEY PURPOSE: ${script.goalText}

QUESTIONS / TOPICS TO COVER: ${script.servicesInfo}
${script.faqDocument ? `\nBACKGROUND / CONTEXT (for your reference only — do not read this aloud): ${script.faqDocument}` : ''}`
    .trim()

  return prompt
}

/**
 * Compiles a Script record into a lean, production-ready system prompt.
 * Target: under 450 tokens (was ~800). Every saved token = faster first word.
 */
function compileSystemPrompt(script) {
  if (script.callType === 'survey') return compileSurveySystemPrompt(script)

  const lang = script.language || 'en'
  const langRule = lang !== 'en' && LANGUAGE_STYLE[lang] ? `${LANGUAGE_STYLE[lang]}\n\n` : ''

  const prompt = `${langRule}You are ${script.agentName}, making an outbound sales call right now to {{prospect_name}}${script.language !== 'en' ? '' : ' (from {{prospect_company}})'}.

COMPANY: ${script.companyInfo}

OFFER: ${script.servicesInfo}

GOAL: ${script.goalText}
${script.objections ? `\nOBJECTIONS: ${script.objections}` : ''}
${script.faqDocument ? `\nFAQ: ${script.faqDocument}` : ''}

CRITICAL OVERRIDES — these take priority over your goal. When the prospect says any of the following, STOP selling immediately and act:
- "Email me / send a proposal / send info / send details" → say "Of course — what's the best email for that?" Capture the email, confirm it back, then use end_call. THIS IS A SUCCESS, not an objection to rebut.
- "Not interested / no thanks" → thank them politely, use end_call with reason NOT_INTERESTED. Do NOT pitch again.
- "I'm busy / call me later / bad time" → ask for a better callback time, use request_callback, then end_call.
- "Remove me / stop calling / don't call me" → confirm the opt-out, use end_call with reason OPTED_OUT immediately.
NEVER repeat the same point twice. If they push back once, move toward email follow-up or a polite close.
Keep the entire call under 3 minutes. Be warm and concise, not pushy.

RULES (follow every one):
- Opening: say ONE short sentence introducing yourself and why you're calling, then ask ONE question. Stop there. Never dump the full pitch upfront.
- Every reply after opening: 1–2 sentences MAX. Never monologue.
- ALWAYS start your reply with a natural spoken filler — "Sure.", "Right.", "Got it.", "Absolutely.", "Of course.", "Mm-hmm." — then continue. This is mandatory, never skip it.
- Always respond to what they just said before moving forward.
- After every point, ask ONE question. Never two.
- Ask for email ONLY when the prospect requests it (see CRITICAL OVERRIDES above). Never ask proactively.
- If asked "Are you AI?" or "Are you a robot?": Redirect naturally — say "I'm [your name], I'm just calling to connect with you about [topic]" and continue without confirming or denying.
- Book meeting: use book_meeting function immediately when they agree. Offer 2 time slots.
- End call: use end_call when booked, clearly not interested, or voicemail.
- Never mention competitors. Never invent prices or timelines.
- Call detect_sentiment silently after every 3 exchanges — never say the result aloud.`
    .trim()

  return prompt
}

/**
 * Vapi function definitions.
 * - Default (sales): book_meeting, request_callback, markNotInterested, end_call, detect_sentiment
 * - Survey mode (callType === 'survey'): record_response, end_call only —
 *   no booking/objection tools, and NO sentiment/buying-intent detection
 *   (that would conflict with staying neutral on a poll).
 */
function getVapiFunctions(callType) {
  const serverUrl    = process.env.BASE_URL + '/api/webhooks/vapi'
  const serverSecret = process.env.VAPI_WEBHOOK_SECRET

  if (callType === 'survey') {
    return [
      {
        type: 'function',
        function: {
          name: 'record_response',
          description: 'Log the person\'s answer to the current survey question, then move to the next question.',
          parameters: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question that was just asked' },
              answer:   { type: 'string', description: 'The person\'s answer, in their own words' }
            },
            required: ['question', 'answer']
          }
        },
        server: { url: serverUrl, secret: serverSecret }
      },
      {
        type: 'endCall',
        function: {
          name: 'end_call',
          description: 'End the call. Use when all questions are answered, the person refuses to continue, wrong number, or voicemail.',
          parameters: {
            type: 'object',
            properties: {
              reason: {
                type: 'string',
                enum: ['COMPLETED', 'REFUSED', 'WRONG_NUMBER', 'VOICEMAIL']
              },
              summary: { type: 'string', description: 'One sentence summary of the call outcome' }
            },
            required: ['reason']
          }
        },
        server: { url: serverUrl, secret: serverSecret }
      }
    ]
  }

  return [
    {
      type: 'function',
      function: {
        name: 'book_meeting',
        description: 'Book a meeting with the prospect. Call immediately when they agree to meet.',
        parameters: {
          type: 'object',
          properties: {
            prospect_name:  { type: 'string', description: 'Full name of the prospect' },
            preferred_slot: { type: 'string', description: 'ISO 8601 datetime, e.g. 2026-07-01T14:00:00Z' },
            notes:          { type: 'string', description: 'Relevant notes from the conversation' }
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
        description: 'Schedule a callback when prospect is busy or asks to be called later.',
        parameters: {
          type: 'object',
          properties: {
            callback_time: { type: 'string', description: 'When to call back — natural language or ISO datetime' },
            notes:         { type: 'string', description: 'What they said' }
          },
          required: ['callback_time']
        }
      },
      server: { url: serverUrl, secret: serverSecret }
    },
    {
      type: 'function',
      function: {
        name: 'markNotInterested',
        description: 'Mark prospect as not interested. Call when they say no, remove me, not interested, or stop calling.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Brief reason they gave' }
          }
        }
      },
      server: { url: serverUrl, secret: serverSecret }
    },
    {
      type: 'endCall',
      function: {
        name: 'end_call',
        description: 'End the call. Use ONLY when booked, callback, voicemail, or wrong number. For not interested, call markNotInterested first, then end_call.',
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
      },
      server: { url: serverUrl, secret: serverSecret }
    },
    {
      // NEW — detect_sentiment: AI reports prospect mood every 3 exchanges
      // This feeds FIX-05 (live sentiment dashboard on the admin panel)
      type: 'function',
      function: {
        name: 'detect_sentiment',
        description: 'Report the current sentiment and buying intent of the prospect. Call every 3 exchanges.',
        parameters: {
          type: 'object',
          properties: {
            sentiment: {
              type: 'string',
              enum: ['VERY_POSITIVE', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'VERY_NEGATIVE'],
              description: 'Overall mood of the prospect right now'
            },
            intent: {
              type: 'string',
              enum: ['HOT', 'WARM', 'COLD', 'UNKNOWN'],
              description: 'Buying intent signal based on what they said'
            },
            buying_signal: {
              type: 'string',
              description: 'Exact phrase or signal that indicates intent — e.g. "asked about pricing", "mentioned timeline"'
            },
            suggested_action: {
              type: 'string',
              enum: ['KEEP_GOING', 'PUSH_FOR_MEETING', 'SLOW_DOWN', 'END_CALL'],
              description: 'What the AI recommends doing next'
            }
          },
          required: ['sentiment', 'intent', 'suggested_action']
        }
      },
      server: { url: serverUrl, secret: serverSecret }
    }
  ]
}

module.exports = { compileSystemPrompt, getVapiFunctions, LANGUAGE_NAMES }
