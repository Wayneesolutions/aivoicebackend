require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const { upsertAssistant } = require('./src/services/vapi')
const { compileSystemPrompt } = require('./src/services/script')
const p = new PrismaClient()

async function run() {
  const scripts = await p.script.findMany({ where: { status: 'APPROVED' } })
  for (const s of scripts) {
    let meta
    try { meta = JSON.parse(s.compiledPrompt || '{}') } catch { continue }
    if (!meta.vapiAssistantId) { console.log('No vapiAssistantId for', s.name); continue }

    const systemPrompt = compileSystemPrompt(s)

    try {
      await upsertAssistant({
        name:                s.name,
        systemPrompt,
        voiceId:             s.voiceId,
        agentName:           s.agentName,
        language:            s.language,
        agentGender:         s.agentGender,
        existingAssistantId: meta.vapiAssistantId,
        maxCallDuration:     s.maxCallDuration,
        callType:            s.callType,
      })
      console.log(`✓ Updated assistant ${meta.vapiAssistantId} for script "${s.name}"`)
    } catch (err) {
      console.error(`✗ Failed "${s.name}":`, err.message)
    }
  }
  await p.$disconnect()
}
run().catch(e => { console.error(e.message); process.exit(1) })
