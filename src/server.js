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

const app        = express()
const httpServer = createServer(app)

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
app.use('/api/webhooks',       express.raw({ type: '*/*' }))
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }))
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

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`VoCallM backend running on port ${PORT}`)
  require('./workers/dialQueue').startWorker()
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
