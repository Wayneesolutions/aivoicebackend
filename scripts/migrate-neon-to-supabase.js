/**
 * migrate-neon-to-supabase.js
 * Copies all data from Neon → Supabase in FK-safe order.
 * Safe to re-run — uses skipDuplicates on every table.
 *
 * Usage:  node scripts/migrate-neon-to-supabase.js
 */

const { PrismaClient } = require('@prisma/client')

const NEON_URL     = 'postgresql://neondb_owner:npg_mQ03TDqRknrN@ep-calm-bonus-apmfsdxf.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&connect_timeout=30'
const SUPABASE_URL = 'postgresql://postgres.buyyjcndcngiqukxmnsw:QuorProject7867@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres'

const src = new PrismaClient({ datasources: { db: { url: NEON_URL } } })
const dst = new PrismaClient({ datasources: { db: { url: SUPABASE_URL } } })

const BATCH = 500

async function migrate(label, fetchFn, insertFn) {
  process.stdout.write(`  ${label}...`)
  const rows = await fetchFn()
  if (!rows.length) { console.log(' 0 rows, skipped'); return }

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const result = await insertFn(chunk)
    inserted += result.count
  }
  console.log(` ${rows.length} rows (${inserted} inserted, ${rows.length - inserted} already existed)`)
}

async function main() {
  console.log('Neon → Supabase migration starting...\n')

  // ── Level 0: no foreign keys ──────────────────────────────────────────────
  await migrate('AdminUser',
    () => src.adminUser.findMany(),
    (d) => dst.adminUser.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('AdminAlert',
    () => src.adminAlert.findMany(),
    (d) => dst.adminAlert.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('Plan',
    () => src.plan.findMany(),
    (d) => dst.plan.createMany({ data: d, skipDuplicates: true })
  )

  // ── Level 1: depends on Plan ──────────────────────────────────────────────
  await migrate('Tenant',
    () => src.tenant.findMany(),
    (d) => dst.tenant.createMany({ data: d, skipDuplicates: true })
  )

  // ── Level 2: depends on Tenant ────────────────────────────────────────────
  await migrate('TenantPhone',
    () => src.tenantPhone.findMany(),
    (d) => dst.tenantPhone.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('TenantUser',
    () => src.tenantUser.findMany(),
    (d) => dst.tenantUser.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('Script',
    () => src.script.findMany(),
    (d) => dst.script.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('LeadBatch',
    () => src.leadBatch.findMany(),
    (d) => dst.leadBatch.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('InboundPhoneNumber',
    () => src.inboundPhoneNumber.findMany(),
    (d) => dst.inboundPhoneNumber.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('WaContactList',
    () => src.waContactList.findMany(),
    (d) => dst.waContactList.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('WaCampaign',
    () => src.waCampaign.findMany(),
    (d) => dst.waCampaign.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('WaTenantConfig',
    () => src.waTenantConfig.findMany(),
    (d) => dst.waTenantConfig.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('WaTemplateRequest',
    () => src.waTemplateRequest.findMany(),
    (d) => dst.waTemplateRequest.createMany({ data: d, skipDuplicates: true })
  )

  // ── Level 3: depends on Script / InboundPhoneNumber / WaContactList ───────
  await migrate('Campaign',
    () => src.campaign.findMany(),
    (d) => dst.campaign.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('InboundAssistant',
    () => src.inboundAssistant.findMany(),
    (d) => dst.inboundAssistant.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('WaContact',
    () => src.waContact.findMany(),
    (d) => dst.waContact.createMany({ data: d, skipDuplicates: true })
  )

  // ── Level 4: depends on Campaign / LeadBatch / InboundAssistant / WaContact
  await migrate('Lead',
    () => src.lead.findMany(),
    (d) => dst.lead.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('InboundCall',
    () => src.inboundCall.findMany(),
    (d) => dst.inboundCall.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('WaCallAttempt',
    () => src.waCallAttempt.findMany(),
    (d) => dst.waCallAttempt.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('WaMessage',
    () => src.waMessage.findMany(),
    (d) => dst.waMessage.createMany({ data: d, skipDuplicates: true })
  )

  // ── Level 5: depends on Lead / Campaign / TenantPhone ─────────────────────
  await migrate('Call',
    () => src.call.findMany(),
    (d) => dst.call.createMany({ data: d, skipDuplicates: true })
  )

  await migrate('UsageLog',
    () => src.usageLog.findMany(),
    (d) => dst.usageLog.createMany({ data: d, skipDuplicates: true })
  )

  console.log('\nMigration complete!')
}

main()
  .catch((e) => { console.error('\nMigration failed:', e.message); process.exit(1) })
  .finally(async () => { await src.$disconnect(); await dst.$disconnect() })
