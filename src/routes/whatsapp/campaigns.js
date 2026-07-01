// backend/src/routes/whatsapp/campaigns.js
// WhatsApp campaign CRUD and send — gated to OPTED_IN contacts at the service layer.

const router = require('express').Router()
const prisma  = require('../../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../../middleware/auth')
const { runCampaign } = require('../../services/waWhatsapp')

// GET /api/whatsapp/campaigns
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const campaigns = await prisma.waCampaign.findMany({
      where:   { tenantId: req.tenant.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { messages: true } } },
    })
    res.json(campaigns)
  } catch (err) { next(err) }
})

// POST /api/whatsapp/campaigns — create a campaign with a Meta-approved template
router.post('/', requireTenantOwner, async (req, res, next) => {
  try {
    const { name, templateName, languageCode } = req.body
    if (!name?.trim())         return res.status(400).json({ error: 'Campaign name is required' })
    if (!templateName?.trim()) return res.status(400).json({ error: 'templateName is required (must be a Meta-approved template)' })

    const campaign = await prisma.waCampaign.create({
      data: {
        tenantId:     req.tenant.id,
        name:         name.trim(),
        templateName: templateName.trim(),
        languageCode: languageCode?.trim() || 'en',
      },
    })
    res.status(201).json(campaign)
  } catch (err) { next(err) }
})

// POST /api/whatsapp/campaigns/:id/send — send campaign to a contact list
// Only OPTED_IN contacts with optedOut=false receive messages (enforced in waWhatsapp.js).
router.post('/:id/send', requireTenantOwner, async (req, res, next) => {
  try {
    const { contactListId } = req.body
    if (!contactListId) return res.status(400).json({ error: 'contactListId is required' })

    const [campaign, contactList] = await Promise.all([
      prisma.waCampaign.findFirst({ where: { id: req.params.id, tenantId: req.tenant.id } }),
      prisma.waContactList.findFirst({ where: { id: contactListId, tenantId: req.tenant.id } }),
    ])

    if (!campaign)     return res.status(404).json({ error: 'Campaign not found' })
    if (!contactList)  return res.status(404).json({ error: 'Contact list not found' })

    // Count eligible contacts so the caller knows what to expect
    const eligibleCount = await prisma.waContact.count({
      where: { contactListId, optInStatus: 'OPTED_IN', optedOut: false },
    })

    if (eligibleCount === 0) {
      return res.json({ sent: 0, failed: 0, attempted: 0, message: 'No opted-in contacts in this list' })
    }

    // Resolve per-tenant WhatsApp credentials (falls back to env vars in runCampaign)
    const waConfig = await prisma.waTenantConfig.findUnique({
      where: { tenantId: req.tenant.id },
    })
    const creds = waConfig
      ? { phoneNumberId: waConfig.phoneNumberId || undefined, accessToken: waConfig.accessToken || undefined }
      : {}

    // Send immediately — for large lists consider a queue; for now this is direct
    const result = await runCampaign({
      campaignId:   campaign.id,
      contactListId,
      templateName: campaign.templateName,
      languageCode: campaign.languageCode,
      creds,
    })

    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
