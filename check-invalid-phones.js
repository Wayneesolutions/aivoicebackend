// check-invalid-phones.js
// Lists all leads with invalid phone numbers (marked WRONG_NUMBER by the system)
// Run: node check-invalid-phones.js
// To delete them: node check-invalid-phones.js --delete

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const DELETE = process.argv.includes('--delete')

async function main() {
  const leads = await p.lead.findMany({
    where: { status: 'WRONG_NUMBER' },
    select: {
      id: true, name: true, phone: true, company: true,
      status: true, createdAt: true,
      campaign: { select: { name: true } }
    },
    orderBy: { createdAt: 'desc' }
  })

  if (!leads.length) {
    console.log('No WRONG_NUMBER leads found.')
    return
  }

  console.log(`Found ${leads.length} lead(s) with invalid/wrong phone numbers:\n`)
  console.table(leads.map(l => ({
    id:       l.id,
    name:     l.name,
    phone:    l.phone,
    company:  l.company || '—',
    campaign: l.campaign?.name || '—',
    added:    l.createdAt.toISOString().slice(0, 10)
  })))

  if (DELETE) {
    const ids = leads.map(l => l.id)
    await p.call.deleteMany({ where: { leadId: { in: ids } } })
    await p.lead.deleteMany({ where: { id: { in: ids } } })
    console.log(`\nDeleted ${leads.length} lead(s) and their call records.`)
  } else {
    console.log(`\nTo delete all of these, run: node check-invalid-phones.js --delete`)
    console.log(`Or fix the phone numbers in the original CSV and re-upload.`)
  }
}

main().catch(console.error).finally(() => p.$disconnect())
