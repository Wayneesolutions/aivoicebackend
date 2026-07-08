const axios = require('axios')

// In-memory cache — refreshed by cron every 30 min, served stale for up to 5 min
let cache = { elevenlabs: null, vapi: null, fetchedAt: null }
const CACHE_TTL_MS = 5 * 60 * 1000

async function fetchElevenLabsCredits() {
  const res = await axios.get('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    timeout: 10000,
  })
  const d = res.data
  return {
    tier: d.tier || 'unknown',
    charactersUsed: d.character_count || 0,
    charactersLimit: d.character_limit || 0,
    charactersRemaining: (d.character_limit || 0) - (d.character_count || 0),
    resetDate: d.next_character_count_reset_unix
      ? new Date(d.next_character_count_reset_unix * 1000).toISOString()
      : null,
  }
}

async function fetchVapiCredits() {
  const now = new Date()
  const billingPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  // VAPI REST API does not expose credit balance — use analytics for monthly spend
  let monthlySpend = null
  try {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString()

    const res = await axios.post('https://api.vapi.ai/analytics', {
      queries: [{
        name: 'monthlyCost',
        table: 'call',
        timeRange: { start, end, step: 'day', timezone: 'UTC' },
        operations: [{ operation: 'sum', column: 'cost' }],
      }],
    }, {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
      timeout: 10000,
    })

    const rows = res.data?.[0]?.result || []
    const total = rows.reduce((sum, row) => sum + (row.sumCost ?? row.sum_cost ?? row.cost ?? 0), 0)
    monthlySpend = parseFloat(total.toFixed(4))
  } catch (_) {
    // analytics failed
  }

  return { monthlySpend, billingPeriod }
}

async function getCredits(forceRefresh = false) {
  const stale = !cache.fetchedAt || (Date.now() - cache.fetchedAt > CACHE_TTL_MS)
  if (!forceRefresh && !stale) return cache

  const [elResult, vapiResult] = await Promise.allSettled([
    fetchElevenLabsCredits(),
    fetchVapiCredits(),
  ])

  cache = {
    elevenlabs: elResult.status === 'fulfilled'
      ? elResult.value
      : { error: elResult.reason?.response?.data?.detail || elResult.reason?.message || 'Failed to fetch' },
    vapi: vapiResult.status === 'fulfilled'
      ? vapiResult.value
      : { error: vapiResult.reason?.response?.data?.message || vapiResult.reason?.message || 'Failed to fetch' },
    fetchedAt: Date.now(),
  }

  return cache
}

module.exports = { getCredits }
