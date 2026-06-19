// backend/src/services/calendar.js
// ============================================================
// BUGFIX — calendar.js
// BUGS FIXED:
//   BUG-1: normaliseSlot() — AI passes natural language like "Monday at 2pm"
//           which caused Cal.com 400 errors. Now converts to ISO 8601 first.
//   BUG-2: Timezone was hardcoded 'America/New_York'. Now passed from caller,
//           defaults to 'America/Toronto'.
// ============================================================

const axios = require('axios')

// ── Slot normaliser ────────────────────────────────────────────────────────────
// Cal.com requires ISO 8601 e.g. "2026-07-01T14:00:00Z"
// The AI sometimes passes natural language like "Monday at 2pm" or "tomorrow afternoon"
// This function converts anything parseable to ISO, and falls back to +24h if not.
function normaliseSlot(slot) {
  if (!slot) {
    console.warn('[calendar] preferred_slot is empty — using +24h fallback')
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  }

  // Already valid ISO 8601 — pass through unchanged
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(slot)) return slot

  // Try native Date parse (handles many common formats)
  const parsed = new Date(slot)
  if (!isNaN(parsed.getTime())) {
    console.log(`[calendar] Converted slot "${slot}" → ${parsed.toISOString()}`)
    return parsed.toISOString()
  }

  // Could not parse — fallback to 24h from now so call doesn't crash
  const fallback = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  console.warn(`[calendar] Could not parse preferred_slot: "${slot}" — using fallback ${fallback}`)
  return fallback
}

// ── Book meeting (public API) ──────────────────────────────────────────────────
// Automatically uses the client's own Cal.com if configured,
// otherwise falls back to Wayne E Solutions master account.
async function bookMeeting({ tenant, prospectName, prospectEmail, preferredSlot, notes, timezone }) {

  // Resolve timezone: caller may pass it, or we read it off the tenant if available
  const tz = timezone || tenant.timezone || 'America/Toronto'

  // Use client's own Cal.com if they've connected it
  if (tenant.calcomApiKey && tenant.calcomEventTypeId) {
    return await bookCalcom({
      apiKey:      tenant.calcomApiKey,
      eventTypeId: parseInt(tenant.calcomEventTypeId),
      prospectName, prospectEmail, preferredSlot, notes, timezone: tz
    })
  }

  // Otherwise use Wayne E Solutions master Cal.com account
  return await bookCalcom({
    apiKey:      process.env.CALCOM_API_KEY,
    eventTypeId: parseInt(process.env.CALCOM_EVENT_TYPE_ID),
    prospectName, prospectEmail, preferredSlot,
    timezone: tz,
    // Add client name to notes so Wayne E Solutions knows which client it's for
    notes: `[Client: ${tenant.name}]\n${notes || ''}`
  })
}

// ── Internal Cal.com API call ──────────────────────────────────────────────────
async function bookCalcom({ apiKey, eventTypeId, prospectName, prospectEmail, preferredSlot, notes, timezone }) {

  // FIX BUG-1: normalise slot to ISO 8601 before sending to Cal.com
  const isoSlot = normaliseSlot(preferredSlot)

  // FIX BUG-2: use the passed timezone, not hardcoded New York
  const tz = timezone || 'America/Toronto'

  console.log(`[calendar] bookCalcom — eventTypeId=${eventTypeId} slot=${isoSlot} tz=${tz} prospect=${prospectName}`)

  try {
    const res = await axios.post(
      'https://api.cal.com/v1/bookings',
      {
        eventTypeId,
        start: isoSlot,
        responses: {
          name:     prospectName,
          email:    prospectEmail || `noemail+${Date.now()}@placeholder.com`,
          location: { optionValue: 'phone', value: 'phone' },
          notes:    notes || ''
        },
        timeZone: tz,
        language: 'en',
        metadata: { source: 'vocallm-ai-caller' }
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    )

    console.log(`[calendar] Booking created — uid=${res.data.uid} startTime=${res.data.startTime}`)

    return {
      uid:        res.data.uid,
      meetingUrl: res.data.uid ? `https://cal.com/booking/${res.data.uid}` : null,
      startTime:  res.data.startTime
    }
  } catch (err) {
    // Log the actual Cal.com API error (not just axios generic message)
    const calError = err.response?.data || err.message
    console.error('[calendar] Cal.com API error:', JSON.stringify(calError))
    throw new Error(typeof calError === 'object' ? JSON.stringify(calError) : calError)
  }
}

// ── Get available slots ────────────────────────────────────────────────────────
// Used by the AI when offering time slots during the call
async function getAvailableSlots({ tenant, dateFrom, dateTo }) {
  const apiKey      = tenant.calcomApiKey || process.env.CALCOM_API_KEY
  const eventTypeId = tenant.calcomEventTypeId || process.env.CALCOM_EVENT_TYPE_ID
  const username    = process.env.CALCOM_USERNAME

  const res = await axios.get('https://api.cal.com/v1/slots', {
    params: {
      eventTypeId,
      startTime:    dateFrom,
      endTime:      dateTo,
      usernameList: [username]
    },
    headers: { Authorization: `Bearer ${apiKey}` }
  })

  // Return next 4 available slots
  const slots = Object.values(res.data.slots || {}).flat()
  return slots.slice(0, 4).map(s => s.time)
}

module.exports = { bookMeeting, getAvailableSlots }
