// Inbound phone number management — buy, import, list, delete
const router = require('express').Router();
const prisma  = require('../lib/prisma');
const { requireTenantUser } = require('../middleware/auth');
const vapiService = require('../services/inboundVapi');
const phoneProviders = require('../services/phoneProviders');

// Uses the dedicated inbound Twilio account when set, falls back to the outbound one.
function getTwilioInbound() {
  return require('twilio')(
    process.env.TWILIO_INBOUND_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_INBOUND_AUTH_TOKEN  || process.env.TWILIO_AUTH_TOKEN,
  );
}

// GET /api/inbound/phone-numbers
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const numbers = await prisma.inboundPhoneNumber.findMany({
      where: { tenantId: req.tenant.id },
      include: {
        assistants: { select: { id: true, agentName: true, status: true } },
        linkedTenantPhone: { select: { id: true, number: true, friendlyName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(numbers);
  } catch (err) { next(err); }
});

// GET /api/inbound/phone-numbers/outbound-candidates — this tenant's own outbound
// (TenantPhone) numbers that aren't already linked to an inbound number, for
// populating the "use this same number for inbound" picker.
router.get('/outbound-candidates', requireTenantUser, async (req, res, next) => {
  try {
    const numbers = await prisma.tenantPhone.findMany({
      where: {
        tenantId: req.tenant.id,
        isActive: true,
        vapiNumberId: { not: null },
        inboundLinks: { none: {} },
      },
      select: { id: true, number: true, friendlyName: true, country: true, provider: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(numbers);
  } catch (err) { next(err); }
});

// POST /api/inbound/phone-numbers/search — search available Twilio numbers
router.post('/search', requireTenantUser, async (req, res, next) => {
  try {
    const { country = 'CA', areaCode, contains } = req.body;
    const twilio = getTwilioInbound();
    const params = { limit: 20, voiceEnabled: true };
    if (areaCode) params.areaCode = areaCode;
    if (contains) params.contains = contains;

    const numbers = await twilio.availablePhoneNumbers(country).local.list(params);
    res.json(numbers.map(n => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      locality: n.locality,
      region: n.region,
      postalCode: n.postalCode,
    })));
  } catch (err) { next(err); }
});

// POST /api/inbound/phone-numbers/buy — buy from Twilio + register with Vapi
router.post('/buy', requireTenantUser, async (req, res, next) => {
  try {
    const { phoneNumber, country = 'CA' } = req.body;
    const twilio = getTwilioInbound();

    const purchased = await twilio.incomingPhoneNumbers.create({ phoneNumber });
    const vapiPhone = await vapiService.importPhoneNumber(phoneNumber, purchased.sid);

    const record = await prisma.inboundPhoneNumber.create({
      data: {
        tenantId:   req.tenant.id,
        phoneNumber,
        country,
        twilioSid:  purchased.sid,
        vapiPhoneId: vapiPhone.id,
        provider:   'twilio',
      }
    });
    res.status(201).json(record);
  } catch (err) { next(err); }
});

// POST /api/inbound/phone-numbers/import — import existing Twilio or Plivo number
router.post('/import', requireTenantUser, async (req, res, next) => {
  try {
    let { phoneNumber, twilioSid, plivoUuid, provider = 'twilio', country = 'CA' } = req.body;
    provider = String(provider).toLowerCase();

    if (!phoneNumber)
      return res.status(400).json({ error: 'phoneNumber is required' });
    if (provider === 'twilio' && !twilioSid)
      return res.status(400).json({ error: 'twilioSid is required for provider "twilio"' });
    if (provider === 'plivo' && !plivoUuid)
      return res.status(400).json({ error: 'plivoUuid is required for provider "plivo"' });

    // Normalise to E.164 — strip spaces/dashes/parens, prepend + if missing
    phoneNumber = phoneNumber.replace(/[\s\-().]/g, '');
    if (!phoneNumber.startsWith('+')) phoneNumber = '+' + phoneNumber;

    const vapiPhoneId = provider === 'plivo'
      ? await phoneProviders.registerInVapiPlivo(phoneNumber)
      : (await vapiService.importPhoneNumber(phoneNumber, twilioSid)).id;

    const record = await prisma.inboundPhoneNumber.create({
      data: {
        tenantId:    req.tenant.id,
        phoneNumber,
        country,
        twilioSid:   provider === 'twilio' ? twilioSid : null,
        plivoUuid:   provider === 'plivo' ? plivoUuid : null,
        vapiPhoneId,
        provider,
      }
    });
    res.status(201).json(record);
  } catch (err) {
    if (err.vapiError) return res.status(400).json({ error: err.message, details: err.vapiError });
    next(err);
  }
});

// POST /api/inbound/phone-numbers/link-outbound — reuse a number already set up
// for outbound calling (TenantPhone) as an inbound number too, WITHOUT importing it
// into Vapi a second time. Use this for e.g. the India business number that
// handles both callback follow-ups (outbound) and answering calls back (inbound) —
// Vapi treats a phone number as one unique resource, so re-importing an
// already-registered number via /import would fail.
router.post('/link-outbound', requireTenantUser, async (req, res, next) => {
  try {
    const { tenantPhoneId } = req.body;
    if (!tenantPhoneId)
      return res.status(400).json({ error: 'tenantPhoneId is required' });

    const tenantPhone = await prisma.tenantPhone.findFirst({
      where: { id: tenantPhoneId, tenantId: req.tenant.id }
    });
    if (!tenantPhone)
      return res.status(404).json({ error: 'Outbound number not found' });
    if (!tenantPhone.vapiNumberId)
      return res.status(400).json({
        error: 'This number has no vapiNumberId yet — it must be fully registered with Vapi for outbound first.'
      });

    const existing = await prisma.inboundPhoneNumber.findUnique({
      where: { phoneNumber: tenantPhone.number }
    });
    if (existing)
      return res.status(409).json({ error: 'This number is already set up for inbound.' });

    const record = await prisma.inboundPhoneNumber.create({
      data: {
        tenantId:            req.tenant.id,
        phoneNumber:         tenantPhone.number,
        country:             tenantPhone.country,
        twilioSid:           tenantPhone.provider === 'TWILIO' ? tenantPhone.twilioSid : null,
        plivoUuid:           tenantPhone.provider === 'PLIVO'  ? tenantPhone.plivoUuid  : null,
        vapiPhoneId:         tenantPhone.vapiNumberId,
        provider:            tenantPhone.provider.toLowerCase(),
        linkedTenantPhoneId: tenantPhone.id,
      }
    });
    res.status(201).json(record);
  } catch (err) { next(err) }
});

// DELETE /api/inbound/phone-numbers/:id
router.delete('/:id', requireTenantUser, async (req, res, next) => {
  try {
    const num = await prisma.inboundPhoneNumber.findFirst({
      where: { id: req.params.id, tenantId: req.tenant.id }
    });
    if (!num) return res.status(404).json({ error: 'Number not found' });

    if (num.vapiPhoneId) {
      await vapiService.deletePhoneNumber(num.vapiPhoneId)
        .catch(e => console.error('[inbound/phones] Vapi delete failed:', e.message));
    }
    if (num.twilioSid) {
      const twilio = getTwilioInbound();
      await twilio.incomingPhoneNumbers(num.twilioSid).remove()
        .catch(e => console.error('[inbound/phones] Twilio release failed:', e.message));
    }

    await prisma.inboundPhoneNumber.delete({ where: { id: req.params.id } });
    res.json({ status: 'deleted', id: req.params.id });
  } catch (err) { next(err); }
});

module.exports = router;
