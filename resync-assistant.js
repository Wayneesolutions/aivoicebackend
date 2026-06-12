require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const axios = require('axios')
const { compileSystemPrompt, getVapiFunctions } = require('./src/services/script')
const p = new PrismaClient()

async function run() {
  const scripts = await p.script.findMany({ where: { status: 'APPROVED' } })
  for (const s of scripts) {
    let meta
    try { meta = JSON.parse(s.compiledPrompt || '{}') } catch { continue }
    if (!meta.vapiAssistantId) { console.log('No vapiAssistantId for', s.name); continue }

    const systemPrompt = compileSystemPrompt(s)

    await axios.patch(
      `https://api.vapi.ai/assistant/${meta.vapiAssistantId}`,
      {
        model: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          systemPrompt,
          tools: getVapiFunctions(),
          temperature: 0.8,
          maxTokens: 250
        },
        firstMessage: `Hi, may I speak with {{prospect_name}}? This is ${s.agentName} calling.`,
        serverUrl: `${process.env.BASE_URL}/api/webhooks/vapi`,
        serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET
      },
      { headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` } }
    )
    console.log(`✓ Updated assistant ${meta.vapiAssistantId} for script "${s.name}"`)
  }
  await p.$disconnect()
}
run().catch(e => { console.error(e.response?.data || e.message); process.exit(1) })
