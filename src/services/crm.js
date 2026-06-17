// backend/src/services/crm.js
// Logs calls to HubSpot — Wayne E Solutions master account or client's own
const hubspot = require('@hubspot/api-client')

async function logCall({ tenant, lead, call }) {
  const token = tenant.hubspotAccessToken || process.env.HUBSPOT_ACCESS_TOKEN
  if (!token) return

  const client = new hubspot.Client({ accessToken: token })

  try {
    // Create or update contact
    let contactId
    try {
      const existing = await client.crm.contacts.searchApi.doSearch({
        filterGroups: [{
          filters: [{ propertyName: 'phone', operator: 'EQ', value: lead.phone }]
        }],
        properties: ['id', 'firstname', 'lastname']
      })
      contactId = existing.results[0]?.id
    } catch {}

    if (!contactId) {
      const [firstName, ...rest] = (lead.name || '').split(' ')
      const contact = await client.crm.contacts.basicApi.create({
        properties: {
          firstname: firstName || '',
          lastname:  rest.join(' ') || '',
          phone:     lead.phone,
          email:     lead.email || '',
          company:   lead.company || '',
          jobtitle:  lead.title || '',
          hs_lead_status: call.outcome === 'BOOKED' ? 'IN_PROGRESS' : 'NEW'
        }
      })
      contactId = contact.id
    }

    // Log call activity
    await client.crm.objects.calls.basicApi.create({
      properties: {
        hs_call_title:     `AI Call — ${tenant.name}`,
        hs_call_duration:  (call.durationSeconds || 0) * 1000,
        hs_call_status:    'COMPLETED',
        hs_call_direction: 'OUTBOUND',
        hs_call_body:      call.transcript ? call.transcript.slice(0, 65000) : 'No transcript',
        hs_call_disposition: call.outcome || 'NO_ANSWER',
        hs_timestamp:      Date.now()
      },
      associations: contactId ? [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }]
      }] : []
    })

    // If booked, create a deal
    if (call.outcome === 'BOOKED' && contactId) {
      await client.crm.deals.basicApi.create({
        properties: {
          dealname:  `Meeting — ${lead.name} (${tenant.name})`,
          dealstage: 'appointmentscheduled',
          pipeline:  'default',
          closedate: call.meetingBookedAt ? new Date(call.meetingBookedAt).getTime() : Date.now()
        },
        associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }]
      })
    }
  } catch (err) {
    console.error('[crm] HubSpot error:', err.message)
  }
}

module.exports = { logCall }
