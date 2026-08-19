// Ensure outbound uses only Twilio — Plivo inactive in TenantPhone (inbound is Vapi-direct, unaffected)
// Run: node fix-outbound-twilio2.js
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  await prisma.tenantPhone.updateMany({
    where: { number: '+918031728447' },
    data:  { isDefault: false, isActive: false },
  })
  await prisma.tenantPhone.updateMany({
    where: { number: '+12363269784' },
    data:  { isDefault: true, isActive: true },
  })

  const phones = await prisma.tenantPhone.findMany({
    where: { tenantId: 'cmq6k41os0000zlglioib40oa' },
    select: { number: true, provider: true, country: true, isDefault: true, isActive: true, vapiNumberId: true },
  })
  console.log('TenantPhone state:')
  phones.forEach(p =>
    console.log(`  ${p.number}  ${p.provider}  country=${p.country}  default=${p.isDefault}  active=${p.isActive}  vapiId=${p.vapiNumberId}`)
  )
}

main().catch(console.error).finally(() => prisma.$disconnect())
