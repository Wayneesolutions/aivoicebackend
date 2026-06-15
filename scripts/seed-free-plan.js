// Run once: node backend/scripts/seed-free-plan.js
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const existing = await prisma.plan.findFirst({ where: { name: 'Free Trial' } })
  if (existing) {
    console.log('Free Trial plan already exists:', existing.id)
    return
  }

  const plan = await prisma.plan.create({
    data: {
      name: 'Free Trial',
      blurb: 'Get started at no cost',
      price: 0.00,
      minutesIncluded: 100,
      features: [
        '100 trial minutes included',
        '1 phone number',
        '1 AI campaign',
        '1 script submission',
        'Email support',
      ],
      isActive: true,
      isPopular: false,
      displayOrder: -1,
    },
  })

  console.log('Free Trial plan created:', plan.id)
}

main().catch(console.error).finally(() => prisma.$disconnect())
