// backend/src/routes/whatsapp/contacts.js
// Contact list upload, retrieval, opt-in stats, and opt-in call triggers.

const router = require('express').Router()
const multer = require('multer')
const { parse } = require('csv-parse/sync')
const XLSX   = require('xlsx')
const { parsePhoneNumberFromString } = require('libphonenumber-js')
const prisma = require('../../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../../middleware/auth')
const { triggerOptInForList } = require('../../services/waVocallm')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

function parseFile(buffer, originalname) {
  const ext = (originalname || '').split('.').pop().toLowerCase()
  if (ext === 'xlsx' || ext === 'xls') {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_json(ws, { defval: '' })
  }
  return parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true })
}

function pickField(row, ...keys) {
  for (const k of keys) {
    const v = row[k] || row[k.toLowerCase()] || row[k.toUpperCase()]
    if (v !== undefined && v !== '') return String(v).trim()
  }
  return null
}

// GET /api/whatsapp/contacts — list all contact lists for the tenant
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const lists = await prisma.waContactList.findMany({
      where:   { tenantId: req.tenant.id },
      orderBy: { uploadedAt: 'desc' },
    })
    res.json(lists)
  } catch (err) { next(err) }
})

// POST /api/whatsapp/contacts/upload — CSV or XLSX upload, creates a new contact list
router.post('/upload', requireTenantOwner, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const listName = req.body.name?.trim()
    if (!listName) return res.status(400).json({ error: 'Contact list name is required' })

    const rows = parseFile(req.file.buffer, req.file.originalname)
    const defaultCountry  = process.env.WA_DEFAULT_COUNTRY || 'US'
    const consentConfirmed = req.body.consentConfirmed === 'true'
    const initialStatus    = consentConfirmed ? 'OPTED_IN' : 'NOT_CONTACTED'
    const result = { imported: 0, skipped: 0, errors: [] }
    const parsed = []

    for (const [i, row] of rows.entries()) {
      const rawPhone = pickField(row, 'phone', 'Phone', 'mobile', 'Mobile', 'number', 'Number')
      if (!rawPhone) {
        result.errors.push(`Row ${i + 2}: missing phone`)
        result.skipped++
        continue
      }

      const phoneObj = parsePhoneNumberFromString(String(rawPhone), defaultCountry)
      if (!phoneObj || !phoneObj.isValid()) {
        result.errors.push(`Row ${i + 2}: invalid phone "${rawPhone}"`)
        result.skipped++
        continue
      }

      parsed.push({
        phone:        phoneObj.format('E.164'),
        fullName:     pickField(row, 'name', 'Name', 'fullName', 'full_name', 'FullName') || null,
        businessName: pickField(row, 'business', 'Business', 'company', 'Company', 'businessName') || null,
        tags:         pickField(row, 'tags', 'Tags') || null,
      })
    }

    // Create the list first so we have its ID
    const contactList = await prisma.waContactList.create({
      data: {
        tenantId:       req.tenant.id,
        name:           listName,
        sourceFilename: req.file.originalname,
        totalContacts:  0,
      },
    })

    // Dedup within the file
    const seen = new Set()
    const toCreate = []
    for (const p of parsed) {
      if (seen.has(p.phone)) { result.skipped++; continue }
      seen.add(p.phone)
      toCreate.push({
        ...p,
        contactListId: contactList.id,
        tenantId:      req.tenant.id,
        optInStatus:   initialStatus,
        optInSource:   consentConfirmed ? 'manual_upload_confirmed' : null,
        optInTimestamp: consentConfirmed ? new Date() : null,
      })
      result.imported++
    }

    if (toCreate.length > 0) {
      await prisma.waContact.createMany({ data: toCreate, skipDuplicates: true })
    }

    await prisma.waContactList.update({
      where: { id: contactList.id },
      data:  { totalContacts: result.imported },
    })

    res.json({ listId: contactList.id, listName, ...result })
  } catch (err) { next(err) }
})

// GET /api/whatsapp/contacts/:listId — contacts in a list (paginated)
router.get('/:listId', requireTenantUser, async (req, res, next) => {
  try {
    const list = await prisma.waContactList.findFirst({
      where: { id: req.params.listId, tenantId: req.tenant.id },
    })
    if (!list) return res.status(404).json({ error: 'Contact list not found' })

    const page  = Math.max(1, parseInt(req.query.page  || '1',  10))
    const limit = Math.min(200, parseInt(req.query.limit || '50', 10))
    const where = { contactListId: list.id }
    if (req.query.optInStatus) where.optInStatus = req.query.optInStatus

    const [contacts, total] = await Promise.all([
      prisma.waContact.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip:    (page - 1) * limit,
        take:    limit,
      }),
      prisma.waContact.count({ where }),
    ])

    res.json({ list, contacts, total, page, pages: Math.ceil(total / limit) })
  } catch (err) { next(err) }
})

// GET /api/whatsapp/contacts/:listId/stats — opt-in status counts
router.get('/:listId/stats', requireTenantUser, async (req, res, next) => {
  try {
    const list = await prisma.waContactList.findFirst({
      where: { id: req.params.listId, tenantId: req.tenant.id },
    })
    if (!list) return res.status(404).json({ error: 'Contact list not found' })

    const groups = await prisma.waContact.groupBy({
      by:    ['optInStatus'],
      where: { contactListId: list.id },
      _count: { id: true },
    })

    const stats = { total: 0, NOT_CONTACTED: 0, PENDING: 0, OPTED_IN: 0, DECLINED: 0, NO_ANSWER: 0, VOICEMAIL: 0, NEEDS_MANUAL_REVIEW: 0, FAILED: 0 }
    for (const g of groups) {
      stats[g.optInStatus] = g._count.id
      stats.total += g._count.id
    }

    res.json(stats)
  } catch (err) { next(err) }
})

// POST /api/whatsapp/contacts/:listId/trigger-optin — fire Vapi opt-in calls
router.post('/:listId/trigger-optin', requireTenantOwner, async (req, res, next) => {
  try {
    const list = await prisma.waContactList.findFirst({
      where: { id: req.params.listId, tenantId: req.tenant.id },
    })
    if (!list) return res.status(404).json({ error: 'Contact list not found' })

    // Respond immediately — calls are placed synchronously but each one is fast
    res.json({ message: 'Opt-in calls are being placed', listId: list.id })

    // Place calls after responding so the HTTP connection isn't held open
    triggerOptInForList(list.id).catch(err =>
      console.error('[whatsapp/contacts] trigger-optin error:', err.message)
    )
  } catch (err) { next(err) }
})

module.exports = router
