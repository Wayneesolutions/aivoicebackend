// backend/src/routes/leads.js
const router = require('express').Router()
const multer = require('multer')
const { parse } = require('csv-parse/sync')
const XLSX = require('xlsx')
const prisma = require('../lib/prisma')
const { requireTenantUser, requireTenantOwner } = require('../middleware/auth')
const { parsePhoneNumberFromString } = require('libphonenumber-js')
const { triggerCampaign } = require('../workers/dialQueue')
const vapiService   = require('../services/vapi')
const scriptService = require('../services/script')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// GET /api/leads — tenant's leads with filters
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const { status, campaignId, unassigned, search, page = 1, limit = 50 } = req.query
    const where = { tenantId: req.tenant.id }
    if (status)               where.status     = status
    if (campaignId)           where.campaignId = campaignId
    if (search) {
      where.OR = [
        { name:  { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { company: { contains: search, mode: 'insensitive' } },
      ]
    }
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
        results.errors.push(`${p.name} (${p.phone}): already exists in the system -- skipped as duplicate`)
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

// DELETE /api/leads/:id — permanently remove lead from database
router.delete('/:id', requireTenantOwner, async (req, res, next) => {
  try {
    await prisma.lead.delete({
      where: { id: req.params.id, tenantId: req.tenant.id },
    })
    res.json({ message: 'Lead deleted' })
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

// POST /api/leads/call — place a single call RIGHT NOW, bypassing the CSV-upload +
// campaign flow entirely (previously the ONLY way to trigger any call was
// upload-a-file → create-campaign → start-campaign, even for one lead).
// Deliberately bypasses campaign calling-hours gating (callFromHour/callToHour/callDays)
// — this is an explicit human "call now" action, same intent as a manual dial button,
// not an automated campaign dial. Caller is responsible for only using it during
// hours appropriate for the destination.
// body: { scriptId, phone, name?, company?, title?, country? }
router.post('/call', requireTenantOwner, async (req, res, next) => {
  try {
    const { scriptId, phone, name, company, title, country } = req.body
    if (!scriptId || !phone) return res.status(400).json({ error: 'scriptId and phone are required' })

    const script = await prisma.script.findFirst({ where: { id: scriptId, tenantId: req.tenant.id } })
    if (!script) return res.status(404).json({ error: 'Script not found' })
    if (!['APPROVED', 'LIVE'].includes(script.status))
      return res.status(400).json({ error: 'Script must be approved before it can be used to call' })

    let vapiAssistantId
    try {
      vapiAssistantId = JSON.parse(script.compiledPrompt || '{}').vapiAssistantId
    } catch { /* falls through to the check below */ }
    if (!vapiAssistantId) return res.status(400).json({ error: 'Script has no compiled Vapi assistant — re-approve it first' })

    const phoneObj = parsePhoneNumberFromString(phone, country || 'US')
    if (!phoneObj || !phoneObj.isValid()) return res.status(400).json({ error: `Invalid phone number "${phone}"` })
    const e164 = phoneObj.format('E.164')
    const leadCountry = (country || 'US').toUpperCase()

    // req.tenant.phoneNumbers is already loaded by requireTenantUser — no extra query
    const phoneRecord =
      req.tenant.phoneNumbers.find(n => n.country === leadCountry && n.isDefault && n.isActive && n.vapiNumberId) ||
      req.tenant.phoneNumbers.find(n => n.country === leadCountry && n.isActive && n.vapiNumberId) ||
      req.tenant.phoneNumbers.find(n => n.isActive && n.vapiNumberId)
    if (!phoneRecord) return res.status(400).json({ error: 'No active phone number configured for your account — contact your admin' })

    let lead = await prisma.lead.findFirst({ where: { tenantId: req.tenant.id, phone: e164 } })
    if (lead?.isOptedOut) return res.status(400).json({ error: 'This lead has opted out of calls and cannot be called' })

    if (lead) {
      lead = await prisma.lead.update({
        where: { id: lead.id },
        data: {
          name:    name || lead.name,
          company: company !== undefined ? company : lead.company,
          title:   title   !== undefined ? title   : lead.title,
        }
      })
    } else {
      lead = await prisma.lead.create({
        data: {
          tenantId: req.tenant.id, phone: e164,
          name:    (name || 'Unnamed lead').trim(),
          company: company || null,
          title:   title   || null,
          country: leadCountry,
        }
      })
    }

    // Same optimistic lock dialQueue.js uses — prevents double-dialing if this
    // endpoint is hit twice in quick succession for the same lead.
    const grabbed = await prisma.lead.updateMany({
      where: { id: lead.id, status: { not: 'CALLING' } },
      data:  { status: 'CALLING' }
    })
    if (grabbed.count === 0) return res.status(409).json({ error: 'This lead already has a call in progress' })

    const callRecord = await prisma.call.create({
      data: {
        tenantId: req.tenant.id, leadId: lead.id,
        phoneNumberId: phoneRecord.id,
        status: 'INITIATED', direction: 'outbound',
      }
    })

    let systemPromptOverride = null
    let firstMessageOverride = null
    try {
      if (script.callType === 'survey') firstMessageOverride = scriptService.buildSurveyFirstMessage(script)
      const dateBlock = `TODAY: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. All meetings and callbacks MUST be scheduled for future dates only.\n\n`
      systemPromptOverride = dateBlock + scriptService.compileSystemPrompt(script)
    } catch (err) {
      console.error(`[leads/call] Could not compile prompt for lead ${lead.id}:`, err.message)
    }

    let vapiCall
    try {
      vapiCall = await vapiService.startOutboundCall({
        toNumber: e164,
        vapiNumberId: phoneRecord.vapiNumberId,
        vapiAssistantId,
        voiceOverrideId: req.tenant.clonedVoiceId || undefined,
        systemPromptOverride,
        firstMessageOverride,
        language: script.language,
        agentGender: script.agentGender,
        metadata: {
          tenantId: req.tenant.id, leadId: lead.id, campaignId: null, callRecordId: callRecord.id,
          leadName: lead.name, leadCompany: lead.company || '', leadTitle: lead.title || ''
        }
      })
    } catch (err) {
      await prisma.call.update({ where: { id: callRecord.id }, data: { status: 'FAILED' } }).catch(() => {})
      await prisma.lead.update({ where: { id: lead.id }, data: { status: 'PENDING' } }).catch(() => {})
      const vapiMsg = err.response?.data?.message || err.message
      return res.status(502).json({ error: `Call could not be placed: ${vapiMsg}` })
    }

    await prisma.call.update({
      where: { id: callRecord.id },
      data:  { vapiCallId: vapiCall.id, status: 'RINGING', startedAt: new Date() }
    })
    await prisma.lead.update({
      where: { id: lead.id },
      data:  { callAttempts: { increment: 1 }, lastCalledAt: new Date() }
    })

    res.status(201).json({ message: 'Call initiated', callId: callRecord.id, leadId: lead.id, vapiCallId: vapiCall.id })
  } catch (err) { next(err) }
})

module.exports = router
