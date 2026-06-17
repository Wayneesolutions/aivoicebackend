// backend/src/middleware/auth.js
const jwt = require('jsonwebtoken')
const prisma = require('../lib/prisma')

// Verify JWT and attach user to req
function verifyToken(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' })

  const token = header.split(' ')[1]
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user = payload
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// Must be a super admin (Wayne E Solutions team)
async function requireAdmin(req, res, next) {
  verifyToken(req, res, async () => {
    if (req.user.role !== 'ADMIN')
      return res.status(403).json({ error: 'Admin access required' })
    next()
  })
}

// Must be a tenant user — also resolves their tenant
async function requireTenantUser(req, res, next) {
  verifyToken(req, res, async () => {
    if (req.user.role !== 'TENANT_USER')
      return res.status(403).json({ error: 'Tenant access required' })

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      include: { phoneNumbers: true, plan: true }
    })
    if (!tenant || tenant.status === 'SUSPENDED')
      return res.status(403).json({ error: 'Tenant not found or suspended' })

    req.tenant = tenant
    next()
  })
}

// Tenant owner only (not viewer)
async function requireTenantOwner(req, res, next) {
  requireTenantUser(req, res, () => {
    if (req.user.tenantRole !== 'OWNER')
      return res.status(403).json({ error: 'Owner access required' })
    next()
  })
}

module.exports = { verifyToken, requireAdmin, requireTenantUser, requireTenantOwner }
