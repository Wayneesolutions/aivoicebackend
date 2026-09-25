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
  // Humanize pass (Sep 25 call review): the old block was receptionist-flavoured
  // (appointment/slot examples) and got stacked on top of SALES calls. This one is
  // generic phone-conversation Hinglish. __G_*__ tokens are swapped per agent gender.
  hi: `LANGUAGE & TONE: Talk the way people in Punjab / North India actually talk on the phone — everyday Hinglish, warm, respectful, relaxed. Not formal, not news-anchor, not "shuddh" Hindi.
- Use common English words freely: business, Instagram, page, booking, customer, time, minute, details, sorry, thank you, okay.
- Avoid bookish words: सहायता, उपलब्ध, सुनिश्चित, कृपया, प्रदान, दूरभाष, क्रमांक. Prefer: help, available, confirm, ज़रा, बता दीजिए.
- Write in Devanagari; common English loanwords may be in Devanagari too (बुकिंग, डिटेल्स). PROPER NOUNS (company, person, brand names) exactly as given, letter for letter — e.g. "Wayne E Solutions", never a transliteration.
- Use "आप" and "जी". End sentences with "।" or "?".
- Numbers as spoken words, never raw digits: "साढ़े तीन बजे", phone numbers digit by digit ("नौ, आठ, एक…").

EXAMPLES — match the GOOD style:
- They: "हाँ जी, बोलिए।"  BAD: a 3-sentence intro repeating your name.  GOOD: "जी, बस एक छोटी सी बात थी आपके business के बारे में — एक मिनट है?"
- They: "नहीं है।" (about something you asked)  BAD: ignore it and ask a new scripted question.  GOOD: "अच्छा, कोई बात नहीं जी — असल में इसी में तो हम help करते हैं। अभी नए customers ज़्यादातर कहाँ से आते हैं?"
- They (older, call you "बेटा"): "हाँ बेटा, बोलो।"  GOOD: "जी आंटी जी, बस एक मिनट __G_LUNGI__, ज़्यादा time नहीं __G_LUNGI__।"
- They: "अभी busy हूँ।"  GOOD: "अरे sorry जी, कोई बात नहीं। शाम को call कर __G_LUN__?"`,

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
• YES / HAAN / BOLIYE / THEEK HAI / OKAY → Go to PHASE 2 immediately. Ask Q1. Do NOT re-ask for time or re-verify identity.
• WHO ARE YOU / KAHAN SE / KYA KAAM HAI → Answer briefly from ORGANIZATION + PURPOSE below, then ask "Kya aap 1-2 minute de sakte hain?"
• NO / NAHI / BUSY / ABHI NAHI (to participating) → say "Koi baat nahi, dhanyavad." → end_call REFUSED
• Once the person has confirmed identity or time availability, NEVER ask those things again — move forward.

━━━ PHASE 2: SURVEY QUESTIONS (you are here once consent is given) ━━━
Ask questions one at a time. After EACH answer — no matter what it is:
1. Say ONE short neutral word only: "Okay." OR "Theek hai." OR "Samajh gaya." OR "Achha." OR "Noted." (rotate, never repeat the same one twice in a row)
2. Ask the next question immediately.

⚠ CRITICAL RULES FOR PHASE 2 — read every line:
• "Haan", "Nahi", "Pata nahi", "Koi nahi", "Bilkul nahi", or any short answer = VALID ANSWER. ALWAYS acknowledge + ask next question.
• NEVER re-ask a question that was already answered. If they already told you their name, confirmed their identity, or said they have time — proceed. Do NOT ask again.
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

IDENTITY: "Are you AI?" / "Kya aap robot ho?" → be honest: "Ji, main __AGENT_NAME__ hoon, ek AI assistant — bas 1-2 minute ka survey hai." Then continue. Never claim to be human.
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

const GENDER_TOKENS = {
  female: { __G_LUNGI__: 'लूँगी', __G_LUN__: 'लूँ' },
  male:   { __G_LUNGI__: 'लूँगा', __G_LUN__: 'लूँ' },
}
function applyGenderTokens(text, gender) {
  const map = GENDER_TOKENS[gender === 'male' ? 'male' : 'female']
  return Object.entries(map).reduce((t, [k, v]) => t.split(k).join(v), text)
}

/**
 * Short, human opening line for SALES calls. Deliberately just greeting + name
 * (+ company if callerOrg is set) — then the agent WAITS for "haan ji / boliye".
 * The Sep 25 call showed name being said twice (firstMessage + LLM intro) and a
 * 10s monologue on turn 2; the prompt now knows exactly what was already said.
 */
function buildSalesFirstMessage(script) {
  const lang   = script.language || 'en'
  const gender = script.agentGender === 'male' ? 'male' : 'female'
  const name   = script.agentName || 'Alex'
  const org    = (script.callerOrg || '').trim()

  if (lang === 'hi' || lang === 'hinglish') {
    const verb = gender === 'male' ? 'बोल रहा हूँ' : 'बोल रही हूँ'
    return org ? `नमस्ते जी! मैं ${name} ${verb}, ${org} से।` : `नमस्ते जी! मैं ${name} ${verb}।`
  }
  if (lang === 'pa') {
    const verb = gender === 'male' ? 'ਬੋਲ ਰਿਹਾ ਹਾਂ' : 'ਬੋਲ ਰਹੀ ਹਾਂ'
    return org ? `ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ! ਮੈਂ ${name} ${verb}, ${org} ਤੋਂ।` : `ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ! ਮੈਂ ${name} ${verb}।`
  }
  return org ? `Hi, this is ${name} from ${org}.` : `Hi, this is ${name}.`
}

/** One entry point for every caller (admin approve, dialQueue, test call). */
function buildFirstMessage(script) {
  return script.callType === 'survey' ? buildSurveyFirstMessage(script) : buildSalesFirstMessage(script)
}

/**
 * Compiles a Script record into the SALES system prompt.
 * Rewritten after the Sep 25 call review — focus is on sounding like a person:
 * one short sentence, one question, react to what they actually said, adapt to
 * who is on the line, no fake compliments, honest about being an AI.
 */
function compileSystemPrompt(script) {
  if (script.callType === 'survey') return compileSurveySystemPrompt(script)

  const lang   = script.language || 'en'
  const gender = script.agentGender === 'male' ? 'male' : 'female'
  const name   = script.agentName || 'Alex'
  const org    = (script.callerOrg || '').trim()
  const langRule = lang !== 'en' && LANGUAGE_STYLE[lang] ? `${applyGenderTokens(LANGUAGE_STYLE[lang], gender)}\n\n` : ''
  const firstMessage = buildSalesFirstMessage(script)

  const prompt = `${langRule}You are ${name}, on a live outbound phone call with {{prospect_name}}${lang === 'en' ? ' (from {{prospect_company}})' : ''}. Sound like a friendly, real person from the company below — not a script, not a telemarketer.

ALREADY SAID: Your greeting "${firstMessage}" has just been spoken. Never repeat your name${org ? ' or company' : ''} unless they ask.

YOUR FIRST REPLY (after they answer the greeting): ${org ? '' : 'say which company you are calling from, '}give the reason for the call in ONE short sentence and ask if they have a minute. Around 20 words max. Then stop and listen.

HOW TO SOUND HUMAN
- Short spoken sentences. Usually 1 sentence, 2 at most, under ~25 words. Never a monologue.
- Exactly ONE question per reply, at the end. Never two questions in one reply.
- First react to what they ACTUALLY just said (use their words), then continue. Their answer decides your next line — never jump to the next scripted point as if you didn't hear them.
- A "no" about their situation ("nahi hai", "we don't have that") is information, not rejection — often it is exactly why you called. Acknowledge it and connect it to how you help.
- Acknowledgements ("haan ji", "achha", "sahi hai", "got it") only when natural; vary them, often skip them, never the same one twice in a row.
- Mirror the person: older or calls you "beta" → extra respectful and warm ("ji aunty ji", "ji uncle ji"), slower, simple words, no jargon. Brisk → be brisk. Speaking English → use more English.
- "Hello?" or confusion → re-say your last point more simply. Don't restart the pitch.
- Never state things about their business you were not given (reviews, ratings, followers, revenue). No invented compliments.
- The CLIENT NOTES below are background, not lines to read aloud. Ignore any sample opening lines or other agent names inside them — you are ${name}, and your greeting is already done.

CLIENT NOTES
COMPANY: ${script.companyInfo}
OFFER: ${script.servicesInfo}
GOAL: ${script.goalText}${script.objections ? `\nOBJECTIONS: ${script.objections}` : ''}${script.faqDocument ? `\nFAQ: ${script.faqDocument}` : ''}

WHEN THEY SAY…
- "Send details / email / WhatsApp me" → that is a SUCCESS. Ask where to send it, confirm it back once, thank them, end_call.
- "Not interested / no thanks" → one short warm thank-you, markNotInterested, then end_call NOT_INTERESTED. No second pitch.
- "Busy / call later" → ask what time suits them, request_callback, then end_call CALLBACK.
- "Stop calling / remove me" → short apology, end_call OPTED_OUT immediately.
- Not the right person → ask (one question) who handles it or when to reach the owner, then request_callback.
- Push-back once → don't argue or repeat yourself; offer to send details or close politely.
- They agree to meet → offer 2 specific time slots, then book_meeting right away.
- Keep the whole call under 3 minutes.

HONESTY
- If asked whether you are an AI, a bot, or a recording: say yes, simply and warmly — you are ${name}, an AI assistant calling for the company — and offer to continue or to have the team follow up. Never claim to be human.
- Never invent prices, discounts, or timelines.

Silently call detect_sentiment about every 5 exchanges; never mention it.`
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

module.exports = { compileSystemPrompt, getVapiFunctions, LANGUAGE_NAMES, buildSurveyFirstMessage, buildSalesFirstMessage, buildFirstMessage }
