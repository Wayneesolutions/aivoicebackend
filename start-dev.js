/**
 * Dev startup script — starts cloudflared tunnel, extracts the URL,
 * updates BASE_URL in .env and patches the Vapi assistant, then starts the server.
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

require('dotenv').config()

const ENV_PATH = path.join(__dirname, '.env')

function updateEnv(key, value) {
  let content = fs.readFileSync(ENV_PATH, 'utf8')
  const regex = new RegExp(`^${key}=.*$`, 'm')
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`)
  } else {
    content += `\n${key}=${value}`
  }
  fs.writeFileSync(ENV_PATH, content)
}

async function patchVapiAssistants(baseUrl) {
  const { PrismaClient } = require('@prisma/client')
  const vapiService = require('./src/services/vapi')
  const p = new PrismaClient()
  const scripts = await p.script.findMany({ where: { status: 'APPROVED' } })
  for (const s of scripts) {
    let meta
    try { meta = JSON.parse(s.compiledPrompt || '{}') } catch { continue }
    if (!meta.vapiAssistantId) continue
    try {
      // Full re-upsert — updates top-level serverUrl AND each tool's server.url
      await vapiService.upsertAssistant({
        name: `${s.agentName} — ${s.id}`,
        systemPrompt: meta.prompt,
        voiceId: s.voiceId,
        agentName: s.agentName,
        language: s.language || 'en',
        agentGender: s.agentGender || 'female',
        existingAssistantId: meta.vapiAssistantId
      })
      console.log(`[start-dev] Updated Vapi assistant ${meta.vapiAssistantId} → ${baseUrl}`)
    } catch (e) {
      console.error('[start-dev] Failed to update Vapi assistant:', e.response?.data || e.message)
    }
  }
  await p.$disconnect()
}

function startServer() {
  const server = spawn('node', ['src/server.js'], { stdio: 'inherit', env: process.env, shell: true })
  server.on('exit', (code) => process.exit(code))
}

async function main() {
  console.log('[start-dev] Starting Cloudflare tunnel...')

  const cf = spawn('npx', ['cloudflared', 'tunnel', '--url', 'http://localhost:3001'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true   // required on Windows (npx is npx.cmd)
  })

  let tunnelUrl = null

  function onData(data) {
    const text = data.toString()
    process.stdout.write(text)
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (match && !tunnelUrl) {
      tunnelUrl = match[0]
      console.log(`\n[start-dev] Tunnel URL: ${tunnelUrl}`)

      // Update .env
      updateEnv('BASE_URL', tunnelUrl)
      // Reload env
      require('dotenv').config({ override: true })
      process.env.BASE_URL = tunnelUrl

      // Patch Vapi assistants then start server
      patchVapiAssistants(tunnelUrl).then(() => {
        console.log('[start-dev] Starting backend server...\n')
        startServer()
      }).catch(err => {
        console.error('[start-dev] Vapi patch failed (starting server anyway):', err.message)
        startServer()
      })
    }
  }

  cf.stdout.on('data', onData)
  cf.stderr.on('data', onData)

  cf.on('exit', (code) => {
    console.error('[start-dev] cloudflared exited with code', code)
    process.exit(1)
  })

  // Timeout if no URL found in 30s
  setTimeout(() => {
    if (!tunnelUrl) {
      console.error('[start-dev] Timed out waiting for tunnel URL')
      process.exit(1)
    }
  }, 30000)
}

main()
