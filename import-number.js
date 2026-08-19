const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const phone = await prisma.tenantPhone.create({
    data: {
      tenantId:     'cmq6k41os0000zlglioib40oa',
      number:       '+918031728447',
      friendlyName: 'India Plivo Number',
      country:      'IN',
      provider:     'PLIVO',
      twilioSid:    null,
      plivoUuid:    '918031728447',
      vapiNumberId: '666b5df7-3841-4832-9907-6ca91bc00c66',
      isDefault:    true,
    }
  })
  console.log('Imported:', phone)
}

main().catch(console.error).finally(() => prisma.$disconnect())
