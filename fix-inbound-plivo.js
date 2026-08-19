// Wire up Plivo +918031728447 for inbound (Emily answers)
// Run: node fix-inbound-plivo.js
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const TENANT_ID      = 'cmq6k41os0000zlglioib40oa'   // Wayne Solutions
const PLIVO_NUMBER   = '+918031728447'
const PLIVO_SID      = null                            // Plivo uses plivoUuid, not twilioSid
const VAPI_PHONE_ID  = 'cbc44d20-dd9e-480c-8b2f-c5026cfe9700'
const VAPI_ASST_ID   = '96b4af37-fe60-4fb4-899b-e1ac424d4eb2'   // Emily

async function main() {
  // 1. Re-enable TenantPhone for outbound + inbound use
  await prisma.tenantPhone.updateMany({
    where: { number: PLIVO_NUMBER },
    data: { isActive: true, isDefault: true },
  })
  console.log('TenantPhone re-enabled as default')

  // 2. Upsert InboundPhoneNumber for Plivo number
  const inboundPhone = await prisma.inboundPhoneNumber.upsert({
    where:  { phoneNumber: PLIVO_NUMBER },
    create: {
      tenantId:    TENANT_ID,
      phoneNumber: PLIVO_NUMBER,
      country:     'IN',
      twilioSid:   null,
      vapiPhoneId: VAPI_PHONE_ID,
      provider:    'plivo',
      isActive:    true,
    },
    update: {
      tenantId:    TENANT_ID,
      vapiPhoneId: VAPI_PHONE_ID,
      provider:    'plivo',
      isActive:    true,
    },
  })
  console.log('InboundPhoneNumber:', inboundPhone.id, inboundPhone.phoneNumber)

  // 3. Update InboundAssistant to point to Plivo number
  const assistant = await prisma.inboundAssistant.findFirst({
    where: { tenantId: TENANT_ID },
  })
  if (!assistant) {
    console.error('No InboundAssistant found for tenant')
    return
  }
  const updated = await prisma.inboundAssistant.update({
    where: { id: assistant.id },
    data: {
      vapiAssistantId: VAPI_ASST_ID,
      phoneNumberId:   inboundPhone.id,
      status:          'active',
    },
  })
  console.log('InboundAssistant updated:', updated.id, '→ vapiAssistantId:', updated.vapiAssistantId)

  console.log('\nDone. SIP URI for Plivo inbound Zentrunk:')
  console.log('  sip:+918031728447@b45d7e8e-a779-42cd-a2a2-2f24d97caf9a.sip.vapi.ai')
}

main().catch(console.error).finally(() => prisma.$disconnect())
