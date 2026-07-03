// backend/src/routes/leads.js
const router = require('express').Router()
const multer = require('multer')
const { parse } = require('csv-parse/sync')
const XLSX = require('xlsx')
const prisma = require('../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const { parsePhoneNumberFromString } = require('libphonenumber-js')
const { triggerCampaign } = require('../workers/dialQueue')

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

function parseFileToRows(buffer, originalname) {
  const ext = (originalname || '').split('.').pop().toLowerCase()
  if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_json(ws, { defval: '' })
  }
  return parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true })
}

// POST /api/leads/upload — CSV or XLSX upload
router.post('/upload', requireTenantOwner, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const { campaignId } = req.body

    const rows = parseFileToRows(req.file.buffer, req.file.originalname)

    const results = { imported: 0, skipped: 0, errors: [] }
    const parsed = []

    // Pass 1: parse and validate all rows without hitting the DB
    for (const [i, row] of rows.entries()) {
      const rawPhone = row.phone || row.Phone || row.PHONE || row['Phone Number']
      const name     = row.name  || row.Name  || row.NAME  || `Lead ${i + 1}`

      if (!rawPhone) {
        results.errors.push(`Row ${i + 2}: missing phone`)
        results.skipped++
        continue
      }

      const phoneObj = parsePhoneNumberFromString(rawPhone, row.country || 'US')
      if (!phoneObj || !phoneObj.isValid()) {
        results.errors.push(`Row ${i + 2}: invalid phone "${rawPhone}"`)
        results.skipped++
        continue
      }

      parsed.push({
        phone:   phoneObj.format('E.164'),
        name:    name.trim(),
        email:   row.email   || row.Email   || null,
        company: row.company || row.Company || null,
        title:   row.title   || row.Title   || null,
        country: (row.country || row.Country || 'US').toUpperCase()
      })
    }

    // Pass 2: single batch query for all phones — eliminates N+1
    const phones = parsed.map(p => p.phone)
    const existingPhones = phones.length > 0
      ? new Set(
          (await prisma.lead.findMany({
            where: { tenantId: req.tenant.id, phone: { in: phones } },
            select: { phone: true }
          })).map(l => l.phone)
        )
      : new Set()

    // Deduplicate within the file itself
    const seenInBatch = new Set()
    const toCreate = []
    for (const p of parsed) {
      if (existingPhones.has(p.phone) || seenInBatch.has(p.phone)) {
        results.skipped++
        continue
      }
      seenInBatch.add(p.phone)
      toCreate.push({
        tenantId:   req.tenant.id,
        campaignId: campaignId || null,
        ...p
      })
      results.imported++
    }

    if (toCreate.length > 0) {
      const batch = await prisma.leadBatch.create({
        data: {
          tenantId:   req.tenant.id,
          filename:   req.file.originalname,
          totalCount: toCreate.length
        }
      })
      toCreate.forEach(lead => { lead.uploadBatchId = batch.id })
      await prisma.lead.createMany({ data: toCreate })
      results.batchId = batch.id
    }

    res.json(results)
  } catch (err) { next(err) }
})

// GET /api/leads/batches — list upload batches for the tenant with available/used counts
router.get('/batches', requireTenantUser, async (req, res, next) => {
  try {
    const batches = await prisma.leadBatch.findMany({
      where: { tenantId: req.tenant.id },
      orderBy: { createdAt: 'desc' }
    })

    const batchIds = batches.map(b => b.id)

    // Count available leads per batch (PENDING, unassigned, not opted out)
    const availableCounts = await prisma.lead.groupBy({
      by: ['uploadBatchId'],
      where: {
        tenantId:     req.tenant.id,
        uploadBatchId: { in: batchIds },
        campaignId:   null,
        status:       'PENDING',
        isOptedOut:   false
      },
      _count: { id: true }
    })

    const availableMap = {}
    availableCounts.forEach(row => { availableMap[row.uploadBatchId] = row._count.id })

    const result = batches.map(b => {
      const available = availableMap[b.id] ?? 0
      return {
        id:         b.id,
        filename:   b.filename,
        totalCount: b.totalCount,
        available,
        used:       b.totalCount - available,
        createdAt:  b.createdAt
      }
    })

    res.json(result)
  } catch (err) { next(err) }
})

// PATCH /api/leads/:id/opt-out — mark lead as opted out (preserves the record for suppression)
router.patch('/:id/opt-out', requireTenantOwner, async (req, res, next) => {
  try {
    await prisma.lead.update({
      where: { id: req.params.id, tenantId: req.tenant.id },
      data: { status: 'OPTED_OUT', isOptedOut: true, optedOutAt: new Date() }
    })
    res.json({ message: 'Lead opted out' })
  } catch (err) { next(err) }
})

// DELETE /api/leads/:id — kept for backwards compatibility, same behaviour as PATCH opt-out
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

// POST /api/leads/:id/redial — immediately re-queue a no-answer/voicemail lead
// Resets the lead to PENDING and triggers the campaign scheduler if the campaign is ACTIVE
router.post('/:id/redial', requireTenantOwner, async (req, res, next) => {
  try {
    const existing = await prisma.lead.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      include: { campaign: { select: { id: true, status: true } } }
    })
    if (!existing) return res.status(404).json({ error: 'Lead not found' })

    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: {
        status:       'PENDING',
        callAttempts: 0,
        lastCalledAt: null,
      }
    })

    let queued = false
    const campaignStatus = existing.campaign?.status
    if (existing.campaignId && campaignStatus === 'ACTIVE') {
      await triggerCampaign(existing.campaignId)
      queued = true
    }

    res.json({ lead, queued, campaignStatus: campaignStatus || null })
  } catch (err) { next(err) }
})

module.exports = router
