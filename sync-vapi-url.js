require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const vapiService = require('./src/services/vapi')
const p = new PrismaClient()

async function run() {
  const scripts = await p.script.findMany({ where: { status: 'APPROVED' } })
  console.log(`Found ${scripts.length} APPROVED script(s). BASE_URL=${process.env.BASE_URL}`)
  for (const s of scripts) {
    let meta
    try { meta = JSON.parse(s.compiledPrompt || '{}') } catch { continue }
    if (!meta.vapiAssistantId) continue

    // Full re-upsert — updates top-level serverUrl AND each tool's server.url
    await vapiService.upsertAssistant({
      name: `${s.agentName} — ${s.id}`,
      systemPrompt: meta.prompt,
      voiceId: s.voiceId,
      agentName: s.agentName,
      existingAssistantId: meta.vapiAssistantId
    })
    console.log(`Updated assistant ${meta.vapiAssistantId} → ${process.env.BASE_URL}`)
  }
  await p.$disconnect()
}
run().catch(e => { console.error(e.message); process.exit(1) })
