// backend/src/services/outboundWebhook.js
//
// Delivers call-outcome events to a tenant-configured URL as they happen, so
// integrators don't have to poll GET /api/calls / GET /api/inbound/calls.
// Previously this backend sent NO outbound webhooks at all — every
// integration had to poll. Set Tenant.webhookUrl (+ optional webhookSecret)
// via PATCH /api/tenant/webhook to enable delivery; both null = no-op.
//
// Fire-and-forget by design (same pattern as crmService.syncContact /
// billingService.logUsage elsewhere in webhooks.js) — a slow or dead
// integrator endpoint must never block or fail call processing.

const axios  = require('axios')
const crypto = require('crypto')

const TIMEOUT_MS   = 8000
const MAX_ATTEMPTS = 2   // one retry — covers transient network blips, not a full retry queue

function signBody(bodyStr, secret) {
  return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex')
}

/**
 * @param {object} tenant - must have id, webhookUrl, webhookSecret (the caller already
 *   has this loaded via callRecord.tenant / requireTenantUser — avoids a redundant query)
 * @param {string} event - e.g. 'call.completed'
 * @param {object} data
 */
async function deliverWebhook(tenant, event, data) {
  if (!tenant?.webhookUrl) return // webhooks not configured for this tenant — silent no-op

  const body = JSON.stringify({
    event,
    tenantId: tenant.id,
    timestamp: new Date().toISOString(),
    data,
  })

  const headers = { 'Content-Type': 'application/json', 'X-VoCallM-Event': event }
  if (tenant.webhookSecret) {
    headers['X-VoCallM-Signature'] = signBody(body, tenant.webhookSecret)
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await axios.post(tenant.webhookUrl, body, { headers, timeout: TIMEOUT_MS })
      return
    } catch (err) {
      const detail = err.response ? `HTTP ${err.response.status}` : err.message
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[outboundWebhook] tenant=${tenant.id} event=${event} attempt ${attempt} failed (${detail}) — retrying`)
        await new Promise(r => setTimeout(r, 1500))
      } else {
        console.error(`[outboundWebhook] tenant=${tenant.id} event=${event} FAILED after ${MAX_ATTEMPTS} attempts (${detail}) — event dropped, no queue/DLQ in v1. Integrator should also poll as a fallback.`)
      }
    }
  }
}

module.exports = { deliverWebhook, signBody }
