// backend/src/routes/leads.js
const router = require('express').Router()
const multer = require('multer')
const { parse } = require('csv-parse/sync')
const prisma = require('../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const { parsePhoneNumberFromString } = require('libphonenumber-js')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// GET /api/leads — tenant's leads with filters
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const { status, campaignId, unassigned, page = 1, limit = 50 } = req.query
    const where = { tenantId: req.tenant.id }
    if (status)               where.status     = status
    if (campaignId)           where.campaignId = campaignId
    if (unassigned === 'true') {
      where.campaignId  = null
      where.isOptedOut  = false
      where.status      = 'PENDING'
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit)
      }),
      prisma.lead.count({ where })
    ])
    res.json({ leads, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) })
  } catch (err) { next(err) }
})

// GET /api/leads/unassigned-count — leads not yet in any campaign
router.get('/unassigned-count', requireTenantUser, async (req, res, next) => {
  try {
    const count = await prisma.lead.count({
      where: { tenantId: req.tenant.id, campaignId: null, status: 'PENDING', isOptedOut: false }
    })
    res.json({ count })
  } catch (err) { next(err) }
})

// POST /api/leads/upload — CSV upload
router.post('/upload', requireTenantOwner, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const { campaignId } = req.body

    const content = req.file.buffer.toString('utf8')
    const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true })

    const results = { imported: 0, skipped: 0, errors: [] }
    const toCreate = []

    for (const [i, row] of rows.entries()) {
      const rawPhone = row.phone || row.Phone || row.PHONE || row['Phone Number']
      const name     = row.name  || row.Name  || row.NAME  || `Lead ${i + 1}`
      
      if (!rawPhone) {
        results.errors.push(`Row ${i + 2}: missing phone`)
        results.skipped++
        continue
      }

      // Normalize to E.164
      const parsed = parsePhoneNumberFromString(rawPhone, row.country || 'US')
      if (!parsed || !parsed.isValid()) {
        results.errors.push(`Row ${i + 2}: invalid phone "${rawPhone}"`)
        results.skipped++
        continue
      }

      const phone = parsed.format('E.164')

      // Check if already exists for this tenant
      const exists = await prisma.lead.findFirst({ where: { tenantId: req.tenant.id, phone } })
      if (exists) { results.skipped++; continue }

      toCreate.push({
        tenantId:   req.tenant.id,
        campaignId: campaignId || null,
        name:       name.trim(),
        phone,
        email:      row.email   || row.Email   || null,
        company:    row.company || row.Company || null,
        title:      row.title   || row.Title   || null,
        country:    (row.country || row.Country || 'US').toUpperCase()
      })
      results.imported++
    }

    if (toCreate.length > 0) {
      await prisma.lead.createMany({ data: toCreate })
    }

    res.json(results)
  } catch (err) { next(err) }
})

// DELETE /api/leads/:id — opt out
router.delete('/:id', requireTenantOwner, async (req, res, next) => {
  try {
    await prisma.lead.update({
      where: { id: req.params.id, tenantId: req.tenant.id },
      data: { status: 'OPTED_OUT', isOptedOut: true, optedOutAt: new Date() }
    })
    res.json({ message: 'Lead opted out' })
  } catch (err) { next(err) }
})

// PATCH /api/leads/:id/reset — re-enable an opted-out or exhausted lead for calling
router.patch('/:id/reset', requireTenantOwner, async (req, res, next) => {
  try {
    const lead = await prisma.lead.update({
      where: { id: req.params.id, tenantId: req.tenant.id },
      data: {
        status:      'PENDING',
        isOptedOut:  false,
        optedOutAt:  null,
        callAttempts: 0,
        lastCalledAt: null,
      }
    })
    res.json(lead)
  } catch (err) { next(err) }
})

module.exports = router
