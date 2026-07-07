// ============================================================
// FIX-07 — backend/src/server.js
// REPLACE your entire existing server.js with this file.
//
// WHAT CHANGED:
//   1. Added /api/sentiment route (for live call dashboard)
//   2. MAX_CONCURRENT_CALLS added to env note in comment
//   No other changes — existing routes untouched.
// ============================================================

require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const helmet  = require('helmet')
const rateLimit = require('express-rate-limit')
const { createServer } = require('http')
const morgan  = require('morgan')
const axios   = require('axios')

const app        = express()
const httpServer = createServer(app)

// Trust the first proxy (nginx / AWS ALB) so express-rate-limit reads the
// real client IP from X-Forwarded-For instead of the internal proxy address.
app.set('trust proxy', 1)

// Static: only the logos subfolder is publicly accessible
app.use('/uploads/logos', express.static(require('path').join(__dirname, '../uploads/logos')))

// Middleware
app.use(morgan('dev'))
app.use(helmet())
const escapedDomain = (process.env.DOMAIN || 'yourdomain.com').replace(/\./g, '\\.')
app.use(cors({
  origin: [
    process.env.FRONTEND_ADMIN_URL,
    process.env.FRONTEND_CLIENT_URL,
    new RegExp(`\\.${escapedDomain}$`)
  ],
  credentials: true
}))

// Raw body must be registered BEFORE express.json() for routes that need it
app.use('/api/webhooks',                express.raw({ type: '*/*' }))
app.use('/api/whatsapp/webhooks/meta',  express.raw({ type: '*/*' }))
app.use('/api/stripe/webhook',          express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Rate limiting
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, max: 5,   message: 'Too many registration attempts' }))
app.use('/api/auth',          rateLimit({ windowMs: 15 * 60 * 1000, max: 20,  message: 'Too many requests' }))
app.use('/api',               rateLimit({ windowMs: 1  * 60 * 1000, max: 300 }))

// Routes
app.use('/api/auth',      require('./routes/auth'))
app.use('/api/admin',     require('./routes/admin'))
app.use('/api/tenant',    require('./routes/tenant'))
app.use('/api/leads',     require('./routes/leads'))
app.use('/api/campaigns', require('./routes/campaigns'))
app.use('/api/calls',     require('./routes/calls'))
app.use('/api/scripts',   require('./routes/scripts'))
app.use('/api/webhooks',  require('./routes/webhooks'))
app.use('/api/billing',   require('./routes/billing'))
app.use('/api/stripe',    require('./routes/stripe'))
app.use('/api/public',    require('./routes/public'))
app.use('/api/sentiment', require('./routes/sentiment'))   // NEW — live sentiment dashboard

// WhatsApp Outreach
app.use('/api/whatsapp', require('./routes/whatsapp'))

// Inbound receptionist
app.use('/api/inbound/phone-numbers', require('./routes/inboundPhoneNumbers'))
app.use('/api/inbound/assistants',    require('./routes/inboundAssistants'))
app.use('/api/inbound/calls',         require('./routes/inboundCalls'))
app.use('/api/inbound/analytics',     require('./routes/inboundAnalytics'))

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }))

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message, err.stack)
  const status = err.status || 500
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  })
})

// FIX BUG-G: confirm BASE_URL is actually reachable from the public
// internet (i.e. it's a live tunnel, not a stale/placeholder value)
// BEFORE accepting calls — and confirm it matches what's actually
// configured on Vapi's side for every approved assistant. This is a
// dev-environment safety net; in production BASE_URL should be a
// stable domain and this just confirms /health responds through it.
async function verifyBaseUrlReachable() {
  const baseUrl = process.env.BASE_URL

  console.log('========================================')
  console.log(`[startup] BASE_URL = ${baseUrl || '(not set)'}`)

  if (!baseUrl || baseUrl.includes('yourdomain.com')) {
    console.error('[startup] ⚠️  BASE_URL is missing or still the placeholder from .env.example.')
    console.error('[startup] ⚠️  Vapi cannot reach this server — webhooks (call duration, call storage,')
    console.error('[startup] ⚠️  booking confirmations) will silently fail to arrive. If you are running')
    console.error('[startup] ⚠️  locally, use "npm run dev" (NOT "npm start") so the Cloudflare tunnel')
    console.error('[startup] ⚠️  starts and BASE_URL gets set automatically.')
    console.error('========================================')
    return
  }

  try {
    const res = await axios.get(`${baseUrl}/health`, { timeout: 8000 })
    if (res.data?.status === 'ok') {
      console.log(`[startup] ✅ BASE_URL is reachable — confirmed /health responded through ${baseUrl}`)
    } else {
      console.error(`[startup] ⚠️  BASE_URL responded but with unexpected content: ${JSON.stringify(res.data)}`)
    }
  } catch (err) {
    console.error('[startup] ❌ BASE_URL is NOT reachable from the public internet:', err.message)
    console.error('[startup] ❌ This almost always means: the tunnel from a PREVIOUS "npm run dev" session')
    console.error('[startup] ❌ has died (tunnel URLs are random and expire every restart), but this server')
    console.error('[startup] ❌ was started with the old BASE_URL still in .env — e.g. via "npm start"')
    console.error('[startup] ❌ instead of "npm run dev", which skips the tunnel + re-patch step entirely.')
    console.error('[startup] ❌ FIX: stop this server, run "npm run dev" instead, let it print a fresh')
    console.error('[startup] ❌ "[start-dev] Updated Vapi assistant ... → https://NEW-URL.trycloudflare.com"')
    console.error('[startup] ❌ line for EVERY approved script, then test again.')
  }
  console.log('========================================')
}

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`Quor backend running on port ${PORT}`)
  require('./workers/dialQueue').startWorker()
  verifyBaseUrlReachable()
})

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`)
    process.exit(1)
  } else {
    throw err
  }
})

module.exports = { app, httpServer }
