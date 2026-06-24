// Inbound phone number management — buy, import, list, delete
const router = require('express').Router();
const prisma  = require('../lib/prisma');
const { requireTenantUser } = require('../middleware/auth');
const vapiService = require('../services/inboundVapi');

// GET /api/inbound/phone-numbers
router.get('/', requireTenantUser, async (req, res, next) => {
  try {
    const numbers = await prisma.inboundPhoneNumber.findMany({
      where: { tenantId: req.tenant.id },
      include: { assistants: { select: { id: true, agentName: true, status: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(numbers);
  } catch (err) { next(err); }
});

// POST /api/inbound/phone-numbers/search — search available Twilio numbers
router.post('/search', requireTenantUser, async (req, res, next) => {
  try {
    const { country = 'CA', areaCode, contains } = req.body;
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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

// POST /api/inbound/phone-numbers/import — import existing Twilio number
router.post('/import', requireTenantUser, async (req, res, next) => {
  try {
    const { phoneNumber, twilioSid, country = 'CA' } = req.body;
    const vapiPhone = await vapiService.importPhoneNumber(phoneNumber, twilioSid);

    const record = await prisma.inboundPhoneNumber.create({
      data: {
        tenantId:    req.tenant.id,
        phoneNumber,
        country,
        twilioSid,
        vapiPhoneId: vapiPhone.id,
        provider:    'twilio',
      }
    });
    res.status(201).json(record);
  } catch (err) { next(err); }
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
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.incomingPhoneNumbers(num.twilioSid).remove()
        .catch(e => console.error('[inbound/phones] Twilio release failed:', e.message));
    }

    await prisma.inboundPhoneNumber.delete({ where: { id: req.params.id } });
    res.json({ status: 'deleted', id: req.params.id });
  } catch (err) { next(err); }
});

module.exports = router;
