// tiny helper for ad-hoc scripts: raw SQL through the app's Prisma client, in one tenant schema
import { PrismaClient } from '@billing/db'
export const prisma = new PrismaClient()
export async function sql<T = any>(query: string, ...params: unknown[]): Promise<T[]> {
  return (await prisma.$queryRawUnsafe(query, ...params)) as T[]
}
