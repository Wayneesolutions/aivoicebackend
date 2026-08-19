// Fix inbound receptionist: switch from Plivo BYO to Twilio +12363269784
// Run: node fix-inbound-twilio.js
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const TENANT_ID     = 'cmq6k41os0000zlglioib40oa'  // Wayne Solutions
const TWILIO_NUMBER = '+12363269784'
const TWILIO_SID    = 'PN0e5fedb29e4627a167a29ab77ed2a381'
const VAPI_PHONE_ID = 'e24e9b62-3c64-43de-bfa9-a09a48b81eb4'   // in personal Vapi org
const VAPI_ASST_ID  = '96b4af37-fe60-4fb4-899b-e1ac424d4eb2'   // Emily (personal org)

async function main() {
  // 1. Upsert TenantPhone for the Twilio number
  const tenantPhone = await prisma.tenantPhone.upsert({
    where:  { number: TWILIO_NUMBER },
    create: {
      tenantId:     TENANT_ID,
      number:       TWILIO_NUMBER,
      friendlyName: 'Canada - BC (236)',
      country:      'CA',
      provider:     'TWILIO',
      twilioSid:    TWILIO_SID,
      vapiNumberId: VAPI_PHONE_ID,
      isDefault:    false,
      isActive:     true,
    },
    update: {
      tenantId:     TENANT_ID,
      vapiNumberId: VAPI_PHONE_ID,
      isActive:     true,
    },
  })
  console.log('TenantPhone:', tenantPhone.id, tenantPhone.number)

  // 2. Upsert InboundPhoneNumber for the Twilio number
  const inboundPhone = await prisma.inboundPhoneNumber.upsert({
    where:  { phoneNumber: TWILIO_NUMBER },
    create: {
      tenantId:    TENANT_ID,
      phoneNumber: TWILIO_NUMBER,
      country:     'CA',
      twilioSid:   TWILIO_SID,
      vapiPhoneId: VAPI_PHONE_ID,
      provider:    'twilio',
      isActive:    true,
    },
    update: {
      tenantId:    TENANT_ID,
      vapiPhoneId: VAPI_PHONE_ID,
      isActive:    true,
    },
  })
  console.log('InboundPhoneNumber:', inboundPhone.id, inboundPhone.phoneNumber)

  // 3. Find Wayne Solutions inbound assistant and update it
  const assistant = await prisma.inboundAssistant.findFirst({
    where: { tenantId: TENANT_ID },
  })
  if (!assistant) {
    console.error('No InboundAssistant found for tenant', TENANT_ID)
    return
  }
  console.log('Found InboundAssistant:', assistant.id, '| old vapiAssistantId:', assistant.vapiAssistantId)

  const updated = await prisma.inboundAssistant.update({
    where: { id: assistant.id },
    data: {
      vapiAssistantId: VAPI_ASST_ID,
      phoneNumberId:   inboundPhone.id,
      status:          'active',
    },
  })
  console.log('Updated InboundAssistant:', updated.id, '| new vapiAssistantId:', updated.vapiAssistantId)
  console.log('\nDone. Call +12363269784 to test Emily.')
}

main().catch(console.error).finally(() => prisma.$disconnect())
