// backend/src/routes/auth.js
const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
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
      include: { tenant: true }
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
        primaryColor: user.tenant.primaryColor
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

module.exports = router
