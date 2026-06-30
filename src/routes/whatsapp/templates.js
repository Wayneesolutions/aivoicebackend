// backend/src/routes/whatsapp/templates.js
// Client-facing template request CRUD.
// Clients submit templates → admin reviews → admin submits to Meta.

const router = require('express').Router()
const prisma  = require('../../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../../middleware/auth')

const VALID_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION']

// GET /api/whatsapp/templates
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const templates = await prisma.waTemplateRequest.findMany({
      where:   { tenantId: req.tenant.id },
      orderBy: { createdAt: 'desc' },
    })
    res.json(templates)
  } catch (err) { next(err) }
})

// POST /api/whatsapp/templates — submit a new template request
router.post('/', requireTenantOwner, async (req, res, next) => {
  try {
    const { name, category, languageCode, headerText, bodyText, footerText, buttons } = req.body

    if (!name?.trim())     return res.status(400).json({ error: 'Template name is required' })
    if (!bodyText?.trim()) return res.status(400).json({ error: 'Body text is required' })

    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!cleanName) return res.status(400).json({ error: 'Template name must contain letters or numbers' })

    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Category must be one of: ${VALID_CATEGORIES.join(', ')}` })
    }

    const template = await prisma.waTemplateRequest.create({
      data: {
        tenantId:    req.tenant.id,
        name:        cleanName,
        category:    category || 'MARKETING',
        languageCode: languageCode?.trim() || 'en',
        headerText:  headerText?.trim() || null,
        bodyText:    bodyText.trim(),
        footerText:  footerText?.trim() || null,
        buttons:     Array.isArray(buttons) && buttons.length > 0 ? buttons : undefined,
        status:      'PENDING_ADMIN',
      },
    })

    res.status(201).json(template)
  } catch (err) { next(err) }
})

// DELETE /api/whatsapp/templates/:id — delete DRAFT or ADMIN_REJECTED templates only
router.delete('/:id', requireTenantOwner, async (req, res, next) => {
  try {
    const tpl = await prisma.waTemplateRequest.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
    })
    if (!tpl) return res.status(404).json({ error: 'Template not found' })
    if (!['DRAFT', 'ADMIN_REJECTED', 'META_REJECTED'].includes(tpl.status)) {
      return res.status(400).json({ error: 'Only rejected templates can be deleted' })
    }

    await prisma.waTemplateRequest.delete({ where: { id: tpl.id } })
    res.json({ deleted: true })
  } catch (err) { next(err) }
})

module.exports = router
