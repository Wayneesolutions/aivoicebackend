// debug-optout-phrases.js
// Tests the detectOptOut logic locally — no DB, no network, no side effects.
// Run: node debug-optout-phrases.js

const OPT_OUT_PHRASES = [
  'remove me from your call list',
  'remove me from the call list',
  'remove me from your calling list',
  'take me off the calling list',
  'take me off your calling list',
  'take me off your call list',
  'take me off your list',
  'take me off the list',
  'remove me from your list',
  'please remove me',
  'stop calling me',
  'do not call me again',
  "don't call me again",
  'add me to your do not call',
  'put me on your do not call',
  'opt me out',
]

const SOFT_OPT_OUT_PHRASES = [
  "please don't call us anymore",
  "please don't call us again",
  "please don't call again",
  "please don't call back",
  "don't call us again",
  "don't call us back",
  "don't call us anymore",
  "never call us again",
  "never call me again",
  "please don't contact us",
  "don't contact us again",
  "do not contact us again",
  "do not contact us",
  "we don't want to be contacted",
  "we do not want to be contacted",
  "please stop calling",
  "please stop contacting",
  "not interested now or ever",
  "not interested, ever",
  "we will never need your services",
  "we'll never need your services",
  "will never need your services",
  "we never want to hear from you",
  "we don't want any more calls",
  "we don't want any calls from you",
  "we don't want to receive calls",

  // Service rejection
  "we don't need any services",
  "we don't need your services",
  "don't need any services",
  "don't need your services",
  "no need for your services",
  "not interested in any services",
  "we have no need for your services",
  "we don't require any services",
]

function detectOptOut(transcript, summary, currentOutcome) {
  if (currentOutcome === 'OPTED_OUT' || currentOutcome === 'BOOKED') {
    return { result: currentOutcome, tier: null, matched: null }
  }
  const text = ((transcript || '') + ' ' + (summary || '')).toLowerCase()

  const tier1 = OPT_OUT_PHRASES.find(phrase => text.includes(phrase))
  if (tier1) return { result: 'OPTED_OUT', tier: 1, matched: tier1 }

  const tier2 = SOFT_OPT_OUT_PHRASES.find(phrase => text.includes(phrase))
  if (tier2) return { result: 'OPTED_OUT', tier: 2, matched: tier2 }

  return { result: currentOutcome, tier: null, matched: null }
}

// ── Test cases ────────────────────────────────────────────────────────────────
const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET  = '\x1b[0m'

const tests = [
  // ── Should → OPTED_OUT (Tier 1 explicit) ─────────────────────────────────
  {
    label:    'Tier 1: "stop calling me"',
    transcript: '[USER] Please stop calling me. I am not interested.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    'Tier 1: "remove me from your list"',
    transcript: '[USER] Remove me from your list please.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    "Tier 1: \"don't call me again\"",
    transcript: "[USER] I'm not interested, don't call me again.",
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    'Tier 1: "do not call me again"',
    transcript: '[USER] Do not call me again.',
    summary:  null,
    outcome:  'NO_ANSWER',
    expect:   'OPTED_OUT',
  },
  {
    label:    'Tier 1: detected in summary not transcript',
    transcript: '[AI] Hi this is Emily. [USER] Goodbye.',
    summary:  'Customer said stop calling me and hung up.',
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },

  // ── Should → OPTED_OUT (Tier 2 soft) ─────────────────────────────────────
  {
    label:    "Tier 2: \"please don't call us anymore\"",
    transcript: "[USER] We don't need any services. Please don't call us anymore.",
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    "Tier 2: \"please don't call back\"",
    transcript: "[USER] Not interested. Please don't call back.",
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    "Tier 2: \"don't call us again\"",
    transcript: "[USER] We're good. Don't call us again.",
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    'Tier 2: "never call us again"',
    transcript: '[USER] Never call us again. Goodbye.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    "Tier 2: \"please don't contact us\"",
    transcript: "[USER] Not interested at all. Please don't contact us.",
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    "Tier 2: \"please stop calling\"",
    transcript: "[USER] We're all set. Please stop calling.",
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    'Tier 2: "we don\'t want any more calls"',
    transcript: "[USER] We don't want any more calls, thank you.",
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    'Tier 2: "not interested now or ever"',
    transcript: '[USER] Not interested now or ever.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    'Tier 2: "will never need your services"',
    transcript: '[USER] We will never need your services.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    'Tier 2: "do not contact us"',
    transcript: '[USER] Do not contact us.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },

  // ── Should → OPTED_OUT (service rejection phrases) ───────────────────────
  {
    label:    'Tier 2: screenshot case — "We don\'t need any services. Thank you."',
    transcript: "[AI] Hi. This is Emily from Wayne eSolutions. How is your current online and lead flow going for your real estate business? [USER] Great. We don't need any services. Thank you. [AI] One moment. Goodbye.",
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    "Tier 2: \"we don't need your services\"",
    transcript: "[USER] We don't need your services, thanks.",
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },
  {
    label:    'Tier 2: "not interested in any services"',
    transcript: '[USER] Not interested in any services.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'OPTED_OUT',
  },

  // ── Should → NOT_INTERESTED (no permanence signal) ────────────────────────
  {
    label:    'NOT_INTERESTED: plain "not interested"',
    transcript: '[USER] Not interested.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'NOT_INTERESTED',
  },
  {
    label:    'NOT_INTERESTED: "we are good, thanks"',
    transcript: '[USER] We are good, thanks. Bye.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'NOT_INTERESTED',
  },
  {
    label:    'NOT_INTERESTED: "no thank you"',
    transcript: '[USER] No thank you.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'NOT_INTERESTED',
  },
  {
    label:    'NOT_INTERESTED: "we already have a provider"',
    transcript: '[USER] We already have a provider, not interested right now.',
    summary:  null,
    outcome:  'NOT_INTERESTED',
    expect:   'NOT_INTERESTED',
  },

  // ── Should be untouched (BOOKED / already OPTED_OUT) ─────────────────────
  {
    label:    'BOOKED: should never be downgraded even if opt-out phrase present',
    transcript: '[USER] Stop calling me. [AI] Great, meeting confirmed.',
    summary:  null,
    outcome:  'BOOKED',
    expect:   'BOOKED',
  },
  {
    label:    'Already OPTED_OUT: should not change',
    transcript: '[USER] Remove me from your list.',
    summary:  null,
    outcome:  'OPTED_OUT',
    expect:   'OPTED_OUT',
  },
]

// ── Run ───────────────────────────────────────────────────────────────────────
let passed = 0
let failed = 0

console.log('\n── detectOptOut debug run ──────────────────────────────────────\n')

for (const t of tests) {
  const { result, tier, matched } = detectOptOut(t.transcript, t.summary, t.outcome)
  const ok = result === t.expect

  if (ok) {
    passed++
    const detail = tier ? `  (tier ${tier}: "${matched}")` : ''
    console.log(`${GREEN}✓ PASS${RESET}  ${t.label}${detail}`)
  } else {
    failed++
    console.log(`${RED}✗ FAIL${RESET}  ${t.label}`)
    console.log(`         expected: ${YELLOW}${t.expect}${RESET}  got: ${YELLOW}${result}${RESET}`)
    if (matched) console.log(`         matched: "${matched}"`)
  }
}

console.log(`\n── Results: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : GREEN}${failed} failed${RESET} / ${tests.length} total ──\n`)
