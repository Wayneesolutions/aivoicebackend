// backend/src/services/calendar.js
// Handles meeting booking — Wayne Solutions master calendar by default,
// or client's own Cal.com / Google Calendar if they've connected it

const axios = require('axios')

/**
 * Book a meeting after a successful call.
 * Automatically uses the client's own calendar if configured,
 * otherwise falls back to Wayne Solutions master calendar.
 */
async function bookMeeting({ tenant, prospectName, prospectEmail, preferredSlot, notes }) {
  // Use client's own Cal.com if they've connected it
  if (tenant.calcomApiKey && tenant.calcomEventTypeId) {
    return await bookCalcom({
      apiKey:      tenant.calcomApiKey,
      eventTypeId: parseInt(tenant.calcomEventTypeId),
      prospectName, prospectEmail, preferredSlot, notes
    })
  }

  // Otherwise use Wayne Solutions master Cal.com account
  return await bookCalcom({
    apiKey:      process.env.CALCOM_API_KEY,
    eventTypeId: parseInt(process.env.CALCOM_EVENT_TYPE_ID),
    prospectName, prospectEmail, preferredSlot, notes,
    // Add client name to notes so Wayne Solutions knows which client it's for
    notes: `[Client: ${tenant.name}]\n${notes || ''}`
  })
}

async function bookCalcom({ apiKey, eventTypeId, prospectName, prospectEmail, preferredSlot, notes }) {
  const res = await axios.post(
    'https://api.cal.com/v1/bookings',
    {
      eventTypeId,
      start: preferredSlot,
      responses: {
        name:     prospectName,
        email:    prospectEmail || `noemail+${Date.now()}@placeholder.com`,
        location: { optionValue: 'phone', value: 'phone' },
        notes:    notes || ''
      },
      timeZone: 'America/New_York',
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

  return {
    uid:        res.data.uid,
    meetingUrl: res.data.attendees?.[0]?.timeZone ? 
      `https://cal.com/booking/${res.data.uid}` : null,
    startTime:  res.data.startTime
  }
}

/**
 * Get available slots for a given date range
 * (used by the AI when offering time slots during the call)
 */
async function getAvailableSlots({ tenant, dateFrom, dateTo }) {
  const apiKey      = tenant.calcomApiKey || process.env.CALCOM_API_KEY
  const eventTypeId = tenant.calcomEventTypeId || process.env.CALCOM_EVENT_TYPE_ID
  const username    = process.env.CALCOM_USERNAME

  const res = await axios.get('https://api.cal.com/v1/slots', {
    params: {
      eventTypeId,
      startTime:  dateFrom,
      endTime:    dateTo,
      usernameList: [username]
    },
    headers: { Authorization: `Bearer ${apiKey}` }
  })

  // Return next 4 available slots
  const slots = Object.values(res.data.slots || {}).flat()
  return slots.slice(0, 4).map(s => s.time)
}

module.exports = { bookMeeting, getAvailableSlots }
