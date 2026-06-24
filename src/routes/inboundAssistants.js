// Inbound AI receptionist configuration
const router      = require('express').Router();
const prisma      = require('../lib/prisma');
const { requireTenantUser } = require('../middleware/auth');
const vapiService   = require('../services/inboundVapi');
const scriptService = require('../services/inboundScript');

// GET /api/inbound/assistants
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const assistants = await prisma.inboundAssistant.findMany({
      where: { tenantId: req.tenant.id },
      include: { phoneNumber: { select: { id: true, phoneNumber: true, country: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(assistants);
  } catch (err) { next(err); }
});

// GET /api/inbound/assistants/:id
router.get('/:id', requireTenantUser, async (req, res, next) => {
  try {
    const assistant = await prisma.inboundAssistant.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id },
      include: { phoneNumber: true },
    });
    if (!assistant) return res.status(404).json({ error: 'Assistant not found' });
    res.json(assistant);
  } catch (err) { next(err); }
});

// POST /api/inbound/assistants — create (saved as draft, not pushed to Vapi)
router.post('/', requireTenantUser, async (req, res, next) => {
  try {
    const {
      agentName, language, voiceId, agentGender,
      businessName, businessType, servicesInfo, faqText,
      businessHours, transferNumber, transferMessage, bookingUrl, maxCallDuration
    } = req.body;

    const firstMessage = scriptService.buildFirstMessage({ agentName, language, agentGender, businessName });
    const systemPrompt = scriptService.buildSystemPrompt({
      agentName, businessName, businessType, servicesInfo, faqText,
      businessHours, transferNumber, bookingUrl, language,
    });

    const assistant = await prisma.inboundAssistant.create({
      data: {
        tenantId: req.tenant.id,
        agentName:       agentName      || 'Alex',
        language:        language       || 'en',
        voiceId,
        agentGender:     agentGender    || 'female',
        businessName,
        businessType,
        servicesInfo,
        faqText,
        businessHours:   businessHours  || {},
        transferNumber,
        transferMessage,
        bookingUrl,
        maxCallDuration: maxCallDuration || 300,
        firstMessage,
        systemPrompt,
        status: 'draft',
      }
    });
    res.status(201).json(assistant);
  } catch (err) { next(err); }
});

// PATCH /api/inbound/assistants/:id — update config, re-generate prompts
router.patch('/:id', requireTenantUser, async (req, res, next) => {
  try {
    const existing = await prisma.inboundAssistant.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id }
    });
    if (!existing) return res.status(404).json({ error: 'Assistant not found' });

    const merged = { ...existing, ...req.body };
    const firstMessage = scriptService.buildFirstMessage({
      agentName: merged.agentName, language: merged.language,
      agentGender: merged.agentGender, businessName: merged.businessName,
    });
    const systemPrompt = scriptService.buildSystemPrompt({
      agentName: merged.agentName, businessName: merged.businessName,
      businessType: merged.businessType, servicesInfo: merged.servicesInfo,
      faqText: merged.faqText, businessHours: merged.businessHours,
      transferNumber: merged.transferNumber, bookingUrl: merged.bookingUrl,
      language: merged.language,
    });

    const updated = await prisma.inboundAssistant.update({
      where: { id: req.params.id },
      data: {
        agentName:       merged.agentName,
        language:        merged.language,
        voiceId:         merged.voiceId,
        agentGender:     merged.agentGender,
        businessName:    merged.businessName,
        businessType:    merged.businessType,
        servicesInfo:    merged.servicesInfo,
        faqText:         merged.faqText,
        businessHours:   merged.businessHours,
        transferNumber:  merged.transferNumber,
        transferMessage: merged.transferMessage,
        bookingUrl:      merged.bookingUrl,
        maxCallDuration: merged.maxCallDuration,
        firstMessage,
        systemPrompt,
      }
    });

    if (updated.vapiAssistantId) {
      vapiService.updateAssistant(updated.vapiAssistantId, updated)
        .catch(e => console.error('[inbound/assistants] Vapi resync failed:', e.message));
    }

    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/inbound/assistants/:id/activate — push to Vapi + link phone number
router.post('/:id/activate', requireTenantUser, async (req, res, next) => {
  try {
    const { phoneNumberId } = req.body;

    const assistant = await prisma.inboundAssistant.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id }
    });
    if (!assistant) return res.status(404).json({ error: 'Assistant not found' });

    const phone = await prisma.inboundPhoneNumber.findFirst({
      where: { id: phoneNumberId, tenantId: req.tenant.id }
    });
    if (!phone) return res.status(404).json({ error: 'Phone number not found' });

    // Create or update Vapi assistant
    let vapiAssistantId = assistant.vapiAssistantId;
    if (!vapiAssistantId) {
      const vapiResult = await vapiService.createAssistant(assistant);
      vapiAssistantId = vapiResult.id;
    } else {
      await vapiService.updateAssistant(vapiAssistantId, assistant);
    }

    // Link phone to assistant in Vapi
    await vapiService.linkPhoneToAssistant(phone.vapiPhoneId, vapiAssistantId);

    const updated = await prisma.inboundAssistant.update({
      where: { id: req.params.id },
      data: { vapiAssistantId, phoneNumberId, status: 'active' }
    });

    res.json({ assistant: updated, vapiAssistantId, message: 'Inbound receptionist is now live' });
  } catch (err) { next(err); }
});

// POST /api/inbound/assistants/:id/deactivate
router.post('/:id/deactivate', requireTenantUser, async (req, res, next) => {
  try {
    const updated = await prisma.inboundAssistant.update({
      where: { id: req.params.id },
      data: { status: 'paused' }
    });
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
