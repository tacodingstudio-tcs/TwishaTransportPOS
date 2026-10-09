import { PrismaClient } from '@prisma/client'

// Singleton Prisma client — shared across the entire app
// In development, reuse across hot-reloads to avoid connection exhaustion
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env['NODE_ENV'] === 'development'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  })

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = db
}

// Re-export Prisma types for use in other packages
export * from '@prisma/client'
