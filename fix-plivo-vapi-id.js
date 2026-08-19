// Update TenantPhone vapiNumberId for +918031728447 after re-registering in personal Vapi org
// Run: node fix-plivo-vapi-id.js
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const PLIVO_NUMBER    = '+918031728447'
const NEW_VAPI_PHONE_ID = 'cbc44d20-dd9e-480c-8b2f-c5026cfe9700'
const NEW_CRED_ID       = 'b45d7e8e-a779-42cd-a2a2-2f24d97caf9a'

async function main() {
  // 1. Update TenantPhone
  const updated = await prisma.tenantPhone.updateMany({
    where: { number: PLIVO_NUMBER },
    data:  { vapiNumberId: NEW_VAPI_PHONE_ID },
  })
  console.log('TenantPhone updated count:', updated.count)

  // 2. Verify
  const record = await prisma.tenantPhone.findFirst({
    where: { number: PLIVO_NUMBER },
    select: { id: true, number: true, vapiNumberId: true, tenantId: true, provider: true, isDefault: true },
  })
  console.log('TenantPhone:', record)

  console.log('\nDone.')
  console.log(`  New Vapi phone ID : ${NEW_VAPI_PHONE_ID}`)
  console.log(`  New credential ID : ${NEW_CRED_ID}`)
  console.log(`  Update .env PLIVO_VAPI_CREDENTIAL_ID=${NEW_CRED_ID}`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
