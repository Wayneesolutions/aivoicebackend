const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const assistants = await prisma.inboundAssistant.findMany({
    include: { phoneNumber: true },
    orderBy: { createdAt: 'desc' },
  })
  console.log('=== InboundAssistants ===')
  assistants.forEach(a => {
    console.log(`  id=${a.id}  status=${a.status}  vapiAssistantId=${a.vapiAssistantId}  phoneNumberId=${a.phoneNumberId}`)
    if (a.phoneNumber) {
      console.log(`    phone=${a.phoneNumber.phoneNumber}  vapiPhoneId=${a.phoneNumber.vapiPhoneId}  active=${a.phoneNumber.isActive}`)
    }
  })

  const phones = await prisma.inboundPhoneNumber.findMany()
  console.log('\n=== InboundPhoneNumbers ===')
  phones.forEach(p => {
    console.log(`  id=${p.id}  number=${p.phoneNumber}  vapiPhoneId=${p.vapiPhoneId}  active=${p.isActive}`)
  })
}

main().catch(console.error).finally(() => prisma.$disconnect())
