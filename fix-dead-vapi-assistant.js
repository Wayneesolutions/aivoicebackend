// Clear dead vapiAssistantId on cmswxhwvd so Go Live creates a fresh one
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const updated = await prisma.inboundAssistant.update({
    where: { id: 'cmswxhwvd0003j0fvdel09g0u' },
    data: { vapiAssistantId: null },
  })
  console.log('Cleared vapiAssistantId:', updated.id, '→ vapiAssistantId:', updated.vapiAssistantId)
  console.log('Now click Go Live → Activate Now and it will create a fresh Vapi assistant.')
}

main().catch(console.error).finally(() => prisma.$disconnect())
