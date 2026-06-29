/**
 * Dev startup script — starts local Redis (Docker), cloudflared tunnel, extracts the URL,
 * updates BASE_URL in .env and patches the Vapi assistant, then starts the server.
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

require('dotenv').config()

const REDIS_CONTAINER = 'vocallm-redis'

// ── Docker helpers ────────────────────────────────────────────────────────────

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'pipe', shell: true })
    let out = '', err = ''
    p.stdout?.on('data', (d) => { out += d.toString() })
    p.stderr?.on('data', (d) => { err += d.toString() })
    p.on('exit', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
}

async function isDockerRunning() {
  const { code } = await runCmd('docker', ['ps', '-q'])
  return code === 0
}

async function startDockerDesktop() {
  const candidates = [
    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Docker\\Docker\\Docker Desktop.exe`,
    'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
  ].filter(Boolean)

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      spawn(`"${p}"`, [], { shell: true, detached: true, stdio: 'ignore' }).unref()
      return true
    }
  }
  // Last-ditch: let the shell find it via PATH
  spawn('cmd', ['/c', 'start', '""', 'Docker Desktop'], { shell: true, detached: true, stdio: 'ignore' }).unref()
  return true
}

async function waitForDocker(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let ticks = 0
  while (Date.now() < deadline) {
    if (await isDockerRunning()) return true
    ticks++
    if (ticks === 1 || ticks % 5 === 0) {
      process.stdout.write(`[start-dev] Waiting for Docker Desktop... (${Math.round(ticks * 3)}s)\n`)
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  return false
}

// Ensures the local Redis Docker container is running before anything else.
// - Boots Docker Desktop automatically if the daemon isn't up yet.
// - Reuses an existing container if it already exists (idempotent).
// - Creates a fresh container on first run.
// - Never blocks server startup on failure — just warns and continues.
async function ensureRedis() {
  const redisUrl = process.env.REDIS_URL || ''
  if (!redisUrl.startsWith('redis://localhost')) {
    console.log('[start-dev] REDIS_URL is not localhost — skipping Docker Redis setup')
    return
  }

  // ── 1. Make sure the Docker daemon is up ─────────────────────────────────
  if (!(await isDockerRunning())) {
    console.log('[start-dev] Docker daemon not running — starting Docker Desktop...')
    await startDockerDesktop()
    const ready = await waitForDocker(90_000)
    if (!ready) {
      console.warn('[start-dev] ⚠️  Docker Desktop did not start within 90s.')
      console.warn('[start-dev]    Start Docker Desktop manually, then re-run: npm run dev')
      return
    }
    console.log('[start-dev] Docker Desktop is ready.')
  }

  // ── 2. Start or create the Redis container ────────────────────────────────
  const start = await runCmd('docker', ['start', REDIS_CONTAINER])
  if (start.code === 0) {
    console.log(`[start-dev] Redis container "${REDIS_CONTAINER}" started (existing)`)
    await new Promise(r => setTimeout(r, 600))
    return
  }

  // Container doesn't exist yet — create it
  console.log(`[start-dev] Creating Redis container "${REDIS_CONTAINER}"...`)
  const create = await runCmd('docker', [
    'run', '-d',
    '--name', REDIS_CONTAINER,
    '-p', '6379:6379',
    '--restart', 'unless-stopped',
    'redis:7-alpine',
    'redis-server', '--loglevel', 'warning',
  ])

  if (create.code === 0) {
    console.log(`[start-dev] Redis container "${REDIS_CONTAINER}" created and started`)
    await new Promise(r => setTimeout(r, 1200))  // first-time image pull needs extra breathing room
  } else {
    console.warn(`[start-dev] ⚠️  Could not create Redis container — dial queue won't work`)
    if (create.err) console.warn('[start-dev]', create.err)
  }
}

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
  await ensureRedis()

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
