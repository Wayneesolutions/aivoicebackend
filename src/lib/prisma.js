// Singleton PrismaClient — import this everywhere instead of calling new PrismaClient()
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

module.exports = prisma
