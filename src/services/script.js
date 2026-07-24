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
- PROPER NOUNS — NEVER modify, transliterate, or phonetically approximate any proper noun. Company names, person names, brand names, and clinic/business names must be used EXACTLY as written in the context — letter for letter, no changes. "Wayne E Solutions" → always write "Wayne E Solutions" (never "Vaini Solutions" or any variant). "GLeuhr Skin Clinic" → always write "GLeuhr Skin Clinic" (never convert to Devanagari). The Devanagari rule above applies only to common English words — never to names.

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
- PROPER NOUNS — NEVER modify, transliterate, or phonetically approximate any proper noun. Company names, person names, brand names must be used EXACTLY as written — letter for letter, no changes.

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

const SURVEY_BASE_RULES = `You are __AGENT_NAME__, a neutral survey representative. Data research only — NOT a sales call. CRITICAL NEUTRALITY: Never influence or react to answers.

YOUR OPENING was pre-recorded and already played. You are now in a live conversation. Follow the phases below strictly.

━━━ PHASE 1: CONSENT (applies ONLY to the very first thing the person said) ━━━
• YES / HAAN / BOLIYE / THEEK HAI / OKAY → Go to PHASE 2 immediately. Ask Q1.
• WHO ARE YOU / KAHAN SE / KYA KAAM HAI → Answer briefly from ORGANIZATION + PURPOSE below, then ask "Kya aap 1-2 minute de sakte hain?"
• NO / NAHI / BUSY / ABHI NAHI (to participating) → say "Koi baat nahi, dhanyavad." → end_call REFUSED

━━━ PHASE 2: SURVEY QUESTIONS (you are here once consent is given) ━━━
Ask questions one at a time. After EACH answer — no matter what it is:
1. Say ONE short word only: "Okay." OR "Theek hai." OR "Bilkul." OR "Samajh gaya." OR "Achha." (rotate, never repeat the same one twice in a row)
2. Ask the next question immediately.

⚠ CRITICAL RULES FOR PHASE 2 — read every line:
• "Haan", "Nahi", "Pata nahi", "Koi nahi", "Bilkul nahi", or any short answer = VALID ANSWER. ALWAYS acknowledge + ask next question.
• NEVER say "Koi baat nahi. Dhanyavad." during the survey — that phrase is ONLY for PHASE 1 consent refusal.
• NEVER say goodbye, NEVER end the call mid-survey because of a "nahi" answer.
• "Hello?" mid-conversation = checking connection → do NOT re-introduce, just repeat the current question.
• If they ask who you are mid-survey → answer briefly, then continue the survey question you were on.

━━━ PHASE 3: CLOSING (after ALL survey questions are answered) ━━━
Say EXACTLY: "बहुत शुक्रिया आपके समय के लिए। आपका दिन अच्छा रहे!"
Then IMMEDIATELY call end_call COMPLETED. Do not wait. Do not speak again after this.

━━━ EXPLICIT REFUSAL (only during survey, not for "nahi" answers) ━━━
end_call REFUSED only if they say: "band karo", "phone rakh do", "survey nahi karna", "nahi sunna", "mat karo"
A "nahi" or "nahi ji" answer to a survey question is NEVER a refusal.

IDENTITY: "Are you AI?" → DENY. Say "Nahi, main __AGENT_NAME__ hoon." Never confirm.
WRONG NUMBER / VOICEMAIL: end_call immediately.`

/**
 * Builds the system prompt for a neutral survey/polling script.
 * Separate from the default sales prompt — no objections, no booking,
 * no persuasion language, no sentiment/buying-intent detection.
 */
function compileSurveySystemPrompt(script) {
  const lang = script.language || 'en'
  const styleRule = SURVEY_STYLE[lang] ? `${SURVEY_STYLE[lang]}\n\n` : ''

  const baseRules = SURVEY_BASE_RULES.split('__AGENT_NAME__').join(script.agentName)

  const prompt = `${styleRule}${baseRules}

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

  const fillerRule = lang === 'hi' || lang === 'hinglish'
    ? '- ALWAYS start your reply with a natural Hindi/Hinglish filler — "हाँ।", "जी।", "बिल्कुल।", "ठीक है।", "अच्छा।", "समझ गया।", "हाँ बिल्कुल।" — then continue. Mandatory, never skip.'
    : lang === 'pa'
    ? '- ALWAYS start your reply with a natural Punjabi filler — "ਹਾਂ।", "ਜੀ।", "ਬਿਲਕੁਲ।", "ਠੀਕ ਹੈ।", "ਸਮਝ ਗਿਆ।" — then continue. Mandatory, never skip.'
    : '- ALWAYS start your reply with a natural spoken filler — "Sure.", "Right.", "Got it.", "Absolutely.", "Of course.", "Mm-hmm." — then continue. Mandatory, never skip.'

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
- Opening (your FIRST reply after they say hello / yes / who is this): Give a structured 3-part intro — (1) your name AND the company you are calling from, (2) the specific reason for your call in one sentence, (3) ONE question — either confirm you are speaking to the right person ("Am I speaking with {{prospect_name}}?") OR ask if they have a moment ("Do you have 2 minutes?"). After this, STOP COMPLETELY and LISTEN. Do not add anything extra. Wait for their response before moving forward.
- Every reply after opening: 1–2 sentences MAX. Never monologue.
${fillerRule}
- Always acknowledge and respond to what they just said before moving forward.
- After every point, ask ONE question. Never two.
- Ask for email ONLY when the prospect requests it (see CRITICAL OVERRIDES above). Never ask proactively.
- If asked "Are you AI?", "Are you a robot?", or told "You are AI" / "You are a bot": DENY it completely — say "No, I'm [your name], I'm calling from [company] to connect with you about [topic]." NEVER say "yes", NEVER say "I am an AI", NEVER say "I pretend to be" — stay fully in character as a human representative at all times, no matter what the person says.
- Book meeting: use book_meeting function immediately when they agree. Offer 2 time slots.
- End call: use end_call when booked, clearly not interested, or voicemail.
- Never mention competitors. Never invent prices or timelines.
- Call detect_sentiment silently after every 5 exchanges — never say the result aloud.`
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
      type: 'function',
      function: {
        name: 'detect_sentiment',
        description: 'Report the current sentiment and buying intent of the prospect. Call every 5 exchanges.',
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

/**
 * Builds the hardcoded firstMessage for survey calls.
 * Full opening delivered before the LLM takes over:
 *   greeting → name → org → purpose → permission ask
 * The LLM system prompt tells the agent NOT to repeat any of this.
 */
function buildSurveyFirstMessage(script) {
  const lang   = script.language || 'en'
  const gender = script.agentGender === 'male' ? 'male' : 'female'
  const name   = script.agentName || 'Agent'

  // callerOrg is a dedicated short field set by the tenant specifically for the greeting.
  // Falls back to nothing — LLM will still mention org from ORGANIZATION section if asked.
  const org = (script.callerOrg || '').trim()

  if (lang === 'hi' || lang === 'hinglish') {
    const verb = gender === 'male' ? 'बोल रहा हूँ' : 'बोल रही हूँ'
    return org
      ? `नमस्ते! मैं ${name} ${verb} — ${org} की तरफ से। क्या आपके पास 1-2 मिनट का समय है?`
      : `नमस्ते! मैं ${name} ${verb}। क्या आपके पास survey के लिए 1-2 मिनट का समय है?`
  }
  if (lang === 'pa') {
    const verb = gender === 'male' ? 'ਬੋਲ ਰਿਹਾ ਹਾਂ' : 'ਬੋਲ ਰਹੀ ਹਾਂ'
    return org
      ? `ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ ${name} ${verb} — ${org} ਦੀ ਤਰਫ਼ ਤੋਂ। ਕੀ ਤੁਹਾਡੇ ਕੋਲ 1-2 ਮਿੰਟ ਦਾ ਸਮਾਂ ਹੈ?`
      : `ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ ${name} ${verb}। ਕੀ ਤੁਹਾਡੇ ਕੋਲ survey ਲਈ 1-2 ਮਿੰਟ ਦਾ ਸਮਾਂ ਹੈ?`
  }
  return org
    ? `Hi, this is ${name} calling on behalf of ${org}. Do you have 1-2 minutes to participate?`
    : `Hi, this is ${name} calling. Do you have 1-2 minutes for a quick survey?`
}

module.exports = { compileSystemPrompt, getVapiFunctions, LANGUAGE_NAMES, buildSurveyFirstMessage }
