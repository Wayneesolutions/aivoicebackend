const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const phone = await prisma.tenantPhone.create({
    data: {
      tenantId:     'cmq6k41os0000zlglioib40oa',
      number:       '+12363269784',
      friendlyName: 'canada buyed number',
      country:      'CA',
      provider:     'TWILIO',
      twilioSid:    'PN0e5fedb29e4627a167a29ab77ed2a381',
      plivoUuid:    null,
      vapiNumberId: 'f293a60a-8cfa-408c-8378-54544c0e1ffa',
      isDefault:    false,
    }
  })
  console.log('Imported:', phone)
}

main().catch(console.error).finally(() => prisma.$disconnect())
