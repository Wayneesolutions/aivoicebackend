// backend/src/services/waTemplates.js
// Meta WhatsApp Template Management API — submit, poll, and handle status webhooks.
// Falls back to shared env-var credentials when a tenant has no WaTenantConfig.

const axios = require('axios')
const prisma = require('../lib/prisma')

function getCredentials(tenantConfig) {
  return {
    wabaId:      tenantConfig?.wabaId      || process.env.WA_WABA_ID,
    accessToken: tenantConfig?.accessToken || process.env.WA_ACCESS_TOKEN,
    graphVersion: process.env.WA_GRAPH_VERSION || 'v21.0',
  }
}

function buildComponents(tpl) {
  const components = []
  if (tpl.headerText) {
    components.push({ type: 'HEADER', format: 'TEXT', text: tpl.headerText })
  }
  components.push({ type: 'BODY', text: tpl.bodyText })
  if (tpl.footerText) {
    components.push({ type: 'FOOTER', text: tpl.footerText })
  }
  const buttons = Array.isArray(tpl.buttons) ? tpl.buttons : []
  if (buttons.length > 0) {
    components.push({ type: 'BUTTONS', buttons })
  }
  return components
}

async function submitTemplateToMeta(templateRequestId) {
  const tpl = await prisma.waTemplateRequest.findUniqueOrThrow({
    where:   { id: templateRequestId },
    include: { tenant: { include: { waTenantConfig: true } } },
  })

  const { wabaId, accessToken, graphVersion } = getCredentials(tpl.tenant.waTenantConfig)
  if (!wabaId)      throw new Error('WA_WABA_ID not configured — set it in .env or in the tenant WA config')
  if (!accessToken) throw new Error('WA_ACCESS_TOKEN not configured')

  const payload = {
    name:       tpl.name,
    category:   tpl.category,
    language:   tpl.languageCode,
    components: buildComponents(tpl),
  }

  let metaRes
  try {
    const res = await axios.post(
      `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`,
      payload,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    )
    metaRes = res.data
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message
    await prisma.waTemplateRequest.update({
      where: { id: tpl.id },
      data:  { status: 'META_REJECTED', metaRejectionReason: detail },
    })
    throw new Error(`Meta API error: ${detail}`)
  }

  await prisma.waTemplateRequest.update({
    where: { id: tpl.id },
    data:  {
      status:        'SUBMITTED_TO_META',
      metaTemplateId: String(metaRes.id || ''),
      metaStatus:    metaRes.status || 'IN_REVIEW',
      submittedAt:   new Date(),
    },
  })

  return metaRes
}

// Called from the Meta webhook when a template_status_update event arrives
async function handleTemplateStatusWebhook(event) {
  const templateId   = String(event.message_template_id || '')
  const metaStatus   = (event.event || '').toUpperCase()   // APPROVED | REJECTED | DISABLED
  const rejectReason = event.reason || null

  if (!templateId || !metaStatus) return

  const statusMap = {
    APPROVED: 'APPROVED',
    REJECTED: 'META_REJECTED',
    DISABLED: 'META_REJECTED',
  }
  const status = statusMap[metaStatus]
  if (!status) return

  await prisma.waTemplateRequest.updateMany({
    where: { metaTemplateId: templateId },
    data:  {
      status,
      metaStatus,
      metaRejectionReason: rejectReason,
    },
  })

  console.log(`[waTemplates] template ${templateId} → ${status} (${metaStatus})`)
}

module.exports = { submitTemplateToMeta, handleTemplateStatusWebhook, getCredentials }
