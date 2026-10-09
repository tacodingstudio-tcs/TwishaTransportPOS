// Jest globalSetup — runs once before all test suites
// Cleans up tenant schemas created by previous test runs (phones starting with 7 or 8)
// Seeded tenants use phones starting with 9, so they are safe.

import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'
import { join } from 'path'
import http from 'http'

function loadEnv() {
  try {
    const envFile = readFileSync(join(__dirname, '../../.env'), 'utf-8')
    for (const line of envFile.split('\n')) {
      const [key, ...rest] = line.split('=')
      if (key && rest.length > 0 && !process.env[key.trim()]) {
        process.env[key.trim()] = rest.join('=').trim()
      }
    }
  } catch { /* .env not found — rely on existing env */ }
}

function callAdminEndpoint(path: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: Number(process.env['TEST_API_PORT'] ?? 3100), path, method: 'POST' },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve(body))
      }
    )
    req.on('error', () => resolve(''))
    req.end()
  })
}

function flushApiDbConnections(): Promise<void> {
  return callAdminEndpoint('/api/admin/flush-db').then(() => undefined)
}

// Applies all provision-schema DDL (including new hotel_* tables) to every
// existing seeded tenant schema so tests run against a fully up-to-date schema.
async function reprovisionAllTenants(): Promise<void> {
  const body = await callAdminEndpoint('/api/admin/reprovision-all')
  try {
    const result = JSON.parse(body)
    if (result.provisioned !== undefined) {
      console.log(`[globalSetup] Reprovisioned ${result.provisioned} tenant schemas`)
    }
  } catch { /* API not running yet — ignore */ }
}

export default async function globalSetup() {
  loadEnv()
  process.env['NODE_ENV'] = 'test'
  // Release all cached tenant DB connections in the API server so we stay under pg max_connections
  await flushApiDbConnections()
  // Apply latest provision-schema DDL (hotel tables, etc.) to all seeded tenant schemas
  await reprovisionAllTenants()
  const db = new PrismaClient()
  try {
    const testTenants = await db.$queryRawUnsafe<Array<{ id: string; schemaName: string }>>(
      `SELECT id, "schemaName" FROM public.tenants WHERE "ownerPhone" ~ '^[78]' ORDER BY "createdAt"`
    )
    for (const t of testTenants) {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${t.schemaName}" CASCADE`)
      await db.$executeRawUnsafe(`DELETE FROM public.tenants WHERE id = '${t.id}'`)
    }
    if (testTenants.length > 0) {
      console.log(`[globalSetup] Cleaned up ${testTenants.length} test tenant schemas`)
    }
  } finally {
    await db.$disconnect()
  }
}
