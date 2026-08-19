// Switch outbound to Twilio +12363269784 — disable Plivo +918031728447
// Run: node fix-outbound-twilio.js
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const TWILIO_NUMBER = '+12363269784'
const PLIVO_NUMBER  = '+918031728447'

async function main() {
  // Make Twilio number the default outbound
  const twilio = await prisma.tenantPhone.updateMany({
    where: { number: TWILIO_NUMBER },
    data: { isDefault: true, isActive: true },
  })
  console.log('Twilio set as default:', twilio)

  // Disable Plivo number — keeps record but excludes it from campaign selection
  const plivo = await prisma.tenantPhone.updateMany({
    where: { number: PLIVO_NUMBER },
    data: { isDefault: false, isActive: false },
  })
  console.log('Plivo disabled:', plivo)

  // Verify
  const phones = await prisma.tenantPhone.findMany({
    where: { number: { in: [TWILIO_NUMBER, PLIVO_NUMBER] } },
    select: { number: true, provider: true, isDefault: true, isActive: true, vapiNumberId: true },
  })
  console.log('\nCurrent state:')
  phones.forEach(p => console.log(` ${p.number}  provider=${p.provider}  default=${p.isDefault}  active=${p.isActive}  vapiId=${p.vapiNumberId}`))
}

main().catch(console.error).finally(() => prisma.$disconnect())
