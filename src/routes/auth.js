// backend/src/routes/auth.js
const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { PrismaClient } = require('@prisma/client')
const { requireAdmin } = require('../middleware/auth')
const emailService = require('../services/email')
const prisma = new PrismaClient()

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  })
}

// POST /api/auth/admin/login
router.post('/admin/login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' })

    const admin = await prisma.adminUser.findUnique({ where: { email } })
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' })

    const valid = await bcrypt.compare(password, admin.passwordHash)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

    const token = signToken({ id: admin.id, email: admin.email, role: 'ADMIN' })
    res.json({ token, user: { id: admin.id, name: admin.name, email: admin.email, role: 'ADMIN' } })
  } catch (err) { next(err) }
})

// POST /api/auth/tenant/login
router.post('/tenant/login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' })

    const user = await prisma.tenantUser.findFirst({
      where: { email },
      include: { tenant: { include: { plan: true } } }
    })
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })
    if (user.tenant.status === 'SUSPENDED')
      return res.status(403).json({ error: 'Account suspended. Contact support.' })

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

    await prisma.tenantUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    })

    const token = signToken({
      id: user.id,
      email: user.email,
      role: 'TENANT_USER',
      tenantRole: user.role,
      tenantId: user.tenantId
    })

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: {
        id: user.tenant.id,
        name: user.tenant.name,
        slug: user.tenant.slug,
        logoUrl: user.tenant.logoUrl,
        primaryColor: user.tenant.primaryColor,
        plan: user.tenant.plan
          ? {
              id: user.tenant.plan.id,
              name: user.tenant.plan.name,
              price: user.tenant.plan.price,
              minutesIncluded: user.tenant.plan.minutesIncluded,
            }
          : null,
      }
    })
  } catch (err) { next(err) }
})

// POST /api/auth/register — self-service tenant signup
router.post('/register', async (req, res, next) => {
  try {
    const { name, company, email, password, planId } = req.body
    if (!name || !company || !email || !password)
      return res.status(400).json({ error: 'name, company, email and password are required' })
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' })

    // Check email not already taken
    const existing = await prisma.tenantUser.findFirst({ where: { email } })
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' })

    // Resolve plan (if supplied)
    let plan = null
    if (planId) {
      plan = await prisma.plan.findUnique({ where: { id: planId } })
      if (!plan || !plan.isActive) return res.status(400).json({ error: 'Invalid or inactive plan' })
    }

    // Build a URL-safe slug from company name
    const baseSlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    // Ensure unique slug
    const existingSlug = await prisma.tenant.findUnique({ where: { slug: baseSlug } })
    const slug = existingSlug ? `${baseSlug}-${Date.now()}` : baseSlug

    const passwordHash = await bcrypt.hash(password, 12)

    const tenant = await prisma.tenant.create({
      data: {
        name: company,
        slug,
        ownerName: name,
        ownerEmail: email,
        ratePerMinute: plan ? plan.price : 0.30,
        planId: plan ? plan.id : undefined,
        users: {
          create: {
            name,
            email,
            passwordHash,
            role: 'OWNER',
          }
        }
      },
      include: { users: true }
    })

    const user = tenant.users[0]
    const token = signToken({
      id: user.id,
      email: user.email,
      role: 'TENANT_USER',
      tenantRole: user.role,
      tenantId: tenant.id,
    })

    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        logoUrl: tenant.logoUrl,
        primaryColor: tenant.primaryColor,
      }
    })
  } catch (err) { next(err) }
})

// POST /api/auth/admin/seed  — creates first admin (run once, then disable)
router.post('/admin/seed', async (req, res, next) => {
  try {
    const count = await prisma.adminUser.count()
    if (count > 0)
      return res.status(400).json({ error: 'Admin already exists' })

    const { email, password, name } = req.body
    const passwordHash = await bcrypt.hash(password, 12)
    const admin = await prisma.adminUser.create({ data: { email, passwordHash, name } })
    res.json({ message: 'Admin created', id: admin.id })
  } catch (err) { next(err) }
})

// ── FORGOT PASSWORD ────────────────────────────────────────────────────────────

// POST /api/auth/admin/forgot-password
router.post('/admin/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email required' })

    const admin = await prisma.adminUser.findUnique({ where: { email } })
    if (!admin) return res.status(404).json({ error: 'No admin account is registered with this email address.' })

    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expiry = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordResetToken: tokenHash, passwordResetExpiry: expiry }
    })

    await emailService.sendPasswordReset(email, rawToken)

    res.json({ message: 'If that email exists, a reset link has been sent.' })
  } catch (err) { next(err) }
})

// POST /api/auth/admin/reset-password
router.post('/admin/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' })
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    const admin = await prisma.adminUser.findFirst({
      where: {
        passwordResetToken: tokenHash,
        passwordResetExpiry: { gt: new Date() }
      }
    })

    if (!admin) return res.status(400).json({ error: 'Reset link is invalid or has expired' })

    const passwordHash = await bcrypt.hash(password, 12)
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash, passwordResetToken: null, passwordResetExpiry: null }
    })

    res.json({ message: 'Password updated successfully. You can now sign in.' })
  } catch (err) { next(err) }
})

// ── ADMIN PROFILE ──────────────────────────────────────────────────────────────

// GET /api/auth/admin/profile
router.get('/admin/profile', requireAdmin, async (req, res, next) => {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, createdAt: true }
    })
    if (!admin) return res.status(404).json({ error: 'Admin not found' })
    res.json(admin)
  } catch (err) { next(err) }
})

// PATCH /api/auth/admin/profile
router.patch('/admin/profile', requireAdmin, async (req, res, next) => {
  try {
    const { name, email, currentPassword, newPassword } = req.body

    const admin = await prisma.adminUser.findUnique({ where: { id: req.user.id } })
    if (!admin) return res.status(404).json({ error: 'Admin not found' })

    const data = {}

    if (name && name.trim()) data.name = name.trim()

    if (email && email !== admin.email) {
      const taken = await prisma.adminUser.findUnique({ where: { email } })
      if (taken) return res.status(409).json({ error: 'That email is already in use' })
      data.email = email.trim().toLowerCase()
    }

    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password required to set a new one' })
      const valid = await bcrypt.compare(currentPassword, admin.passwordHash)
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' })
      if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' })
      data.passwordHash = await bcrypt.hash(newPassword, 12)
    }

    if (Object.keys(data).length === 0)
      return res.status(400).json({ error: 'No changes provided' })

    const updated = await prisma.adminUser.update({
      where: { id: admin.id },
      data,
      select: { id: true, name: true, email: true, createdAt: true }
    })

    res.json(updated)
  } catch (err) { next(err) }
})

module.exports = router
