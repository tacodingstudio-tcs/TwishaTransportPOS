import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import { redis } from './lib/redis.js'

// Route handlers
import { authRoutes } from './routes/auth.js'
import { invoiceRoutes } from './routes/invoices.js'
import { productRoutes } from './routes/products.js'
import { partyRoutes } from './routes/parties.js'
import { paymentRoutes } from './routes/payments.js'
import { stockRoutes } from './routes/stock.js'
import { tenantRoutes } from './routes/tenants.js'
import { aiRoutes } from './routes/ai.js'
import { analyticsRoutes }       from './routes/analytics.js'
import { reportRoutes }          from './routes/reports.js'
import { webhookRoutes } from './routes/webhooks.js'
import { branchRoutes }         from './routes/branches.js'
import { userRoutes }           from './routes/users.js'
import { notificationRoutes }   from './routes/notifications.js'
import { categoryRoutes }       from './routes/categories.js'
import { brandRoutes }          from './routes/brands.js'
import { expenseRoutes }        from './routes/expenses.js'
import { inventoryRoutes }      from './routes/inventory.js'
import { staffRoutes }          from './routes/staff.js'
import { contractRoutes }       from './routes/contracts.js'
import { transportRoutes }      from './routes/transport.js'
import { grnRoutes }            from './routes/grn.js'
import { broadcastRoutes }      from './routes/broadcasts.js'
import { discountRulesRoutes }  from './routes/discount-rules.js'

// Middleware
import { tenantMiddleware } from './middleware/tenant.js'
import { errorHandler } from './middleware/error.js'

const app = Fastify({
  logger: {
    level: process.env['NODE_ENV'] === 'production' ? 'warn' : 'info',
    transport:
      process.env['NODE_ENV'] !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
  bodyLimit: 50 * 1024 * 1024, // 50MB — enough for ~15 high-res chapter photos
  connectionTimeout: 0,        // disable connection timeout for long AI calls
  requestTimeout:    0,        // disable request timeout (AI calls can take 60-120s)
})

// ── Startup guard: require real secrets in production ─────────────────────────
if (process.env['NODE_ENV'] === 'production') {
  if (!process.env['JWT_SECRET']) {
    throw new Error('JWT_SECRET environment variable must be set in production. Refusing to start with a weak default.')
  }
  if (!process.env['DATABASE_URL']) {
    throw new Error('DATABASE_URL environment variable must be set in production.')
  }
}

// ── Security plugins ──────────────────────────────────────────────────────────
await app.register(helmet, { contentSecurityPolicy: false })

// WEB_URL may be blank on a fresh deploy (Render passes an empty string) and may hold several
// comma-separated sites; an empty value must fall back, not be handed to the cors plugin.
const webOrigins = (process.env['WEB_URL'] ?? '').split(',').map((o) => o.trim()).filter(Boolean)

await app.register(cors, {
  origin: webOrigins.length ? webOrigins : ['http://localhost:5173'],
  credentials: true,
})

await app.register(rateLimit, {
  // Tests run in-band against localhost and can exceed 500 req/min easily.
  // Production keeps the tight limit; dev/test gets a higher ceiling.
  max: process.env['NODE_ENV'] === 'production' ? 500 : 10000,
  timeWindow: '1 minute',
  // Always key on the real client IP — never on a client-supplied header.
  // Using x-tenant-id (a header the client controls) lets an attacker
  // rotate fake tenant IDs and get 500 × N requests/minute instead of 500.
  keyGenerator: (req) => req.ip,
})

await app.register(jwt, {
  // Falls back to a deterministic dev string so local dev works without config,
  // but production is blocked above if JWT_SECRET is unset.
  secret: process.env['JWT_SECRET'] ?? 'dev-secret-change-in-production',
  sign: { expiresIn: process.env['JWT_EXPIRES_IN'] ?? '15m' },
})

// ── Global error handler ──────────────────────────────────────────────────────
app.setErrorHandler(errorHandler)

// A NUL character in a query string or JSON body makes Postgres throw (invalid byte sequence 0x00) and
// would surface as a 500. No legitimate input contains one, so refuse it before it reaches a query.
app.addHook('preValidation', async (req, reply) => {
  const hasNul = (v: unknown): boolean => {
    if (typeof v === 'string') return v.includes('\u0000')
    if (Array.isArray(v)) return v.some(hasNul)
    if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasNul)
    return false
  }
  if (hasNul(req.query) || hasNul(req.body)) {
    return reply.status(400).send({ error: 'Bad request', message: 'Input contains an invalid character' })
  }
})

// Allow POST/PUT with no body (no Content-Type sent). Fastify defaults to 415
// for unknown/missing content types; '*' is the fallback for anything not handled.
app.addContentTypeParser('*', (_req, _payload, done) => done(null, {}))

// ── Health check (no auth) ────────────────────────────────────────────────────
app.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  version: process.env['npm_package_version'] ?? '0.0.1',
}))

// ── Test-only: flush all cached tenant DB connections ─────────────────────────
// Used by Jest globalSetup to free connections before each test run.
// Only active outside production to avoid accidental exposure.
if (process.env['NODE_ENV'] !== 'production') {
  app.post('/api/admin/flush-db', async () => {
    const { disconnectAllTenantDbs } = await import('./lib/tenant-db.js')
    await disconnectAllTenantDbs()
    return { flushed: true }
  })

  // Reprovision all seeded tenant schemas with the latest tables/columns.
  // Used by Jest global-setup so hotel/extension tables exist for seeded tenants.
  app.post('/api/admin/reprovision-all', async () => {
    const { db } = await import('@billing/db')
    const { provisionTenantSchema } = await import('./lib/provision-schema.js')
    const tenants = await db.$queryRawUnsafe<{ schemaName: string }[]>(
      `SELECT "schemaName" FROM public.tenants`
    )
    const results: { schema: string; ok: boolean; error?: string }[] = []
    for (const t of tenants) {
      try {
        await provisionTenantSchema(t.schemaName)
        results.push({ schema: t.schemaName, ok: true })
      } catch (err: any) {
        results.push({ schema: t.schemaName, ok: false, error: err?.message })
      }
    }
    return { provisioned: results.filter(r => r.ok).length, results }
  })
}

// ── Public routes (no auth required) ─────────────────────────────────────────
await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(tenantRoutes, { prefix: '/api/tenants' })
// Webhooks authenticate via HMAC signature, not JWT — must stay outside
// the tenantMiddleware block below, since Razorpay's servers have no JWT.
await app.register(webhookRoutes, { prefix: '/api/webhooks' })

// Product images — browser <img src> can't send Authorization headers,
// so we accept the JWT as a ?token= query param instead.
app.get('/api/products/:id/image', async (req, reply) => {
  const { id }    = (req.params as any)
  const { token } = (req.query  as any)

  if (!token) return reply.status(401).send({ error: 'Unauthorized' })

  // Validate id is a UUID before sending to DB to avoid a Prisma/DB error on
  // malformed input (e.g. SQL keywords, path traversal attempts).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (typeof id !== 'string' || !UUID_RE.test(id))
    return reply.status(400).send({ error: 'Invalid product ID' })

  let tdb: any
  try {
    const payload = app.jwt.verify<{ schemaName: string }>(token)
    const { getTenantDb } = await import('./lib/tenant-db.js')
    tdb = getTenantDb(payload.schemaName)
  } catch { return reply.status(401).send({ error: 'Unauthorized' }) }

  const product = await tdb.product.findFirst({
    where: { id }, select: { image: true, imageMime: true },
  })
  if (!product?.image) return reply.status(404).send({ error: 'No image' })
  reply
    .header('Content-Type', product.imageMime ?? 'image/jpeg')
    .header('Cache-Control', 'public, max-age=86400')
    .send(product.image)
})

// ── Protected routes (all go through tenant middleware) ───────────────────────
// tenantMiddleware verifies JWT and sets tenant context on DB connection
await app.register(async (protectedApp) => {
  protectedApp.addHook('preHandler', tenantMiddleware)
  // A viewer is read-only everywhere. Individual routes used to enforce this one by one (and many did
  // not), so it is applied once here, after tenantMiddleware has resolved the user's role.
  protectedApp.addHook('preHandler', async (req, reply) => {
    if (req.role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Read-only users cannot make changes' })
    }
  })

  await protectedApp.register(invoiceRoutes, { prefix: '/api/invoices' })
  await protectedApp.register(productRoutes, { prefix: '/api/products' })
  await protectedApp.register(partyRoutes, { prefix: '/api/parties' })
  await protectedApp.register(paymentRoutes, { prefix: '/api/payments' })
  await protectedApp.register(stockRoutes,         { prefix: '/api/stock' })
  await protectedApp.register(analyticsRoutes,       { prefix: '/api/analytics' })
  await protectedApp.register(reportRoutes,          { prefix: '/api/reports' })
  await protectedApp.register(branchRoutes,          { prefix: '/api/branches' })
  await protectedApp.register(userRoutes,            { prefix: '/api/users' })
  await protectedApp.register(notificationRoutes,    { prefix: '/api/notifications' })
  await protectedApp.register(aiRoutes,             { prefix: '/api/ai' })
  await protectedApp.register(categoryRoutes,       { prefix: '/api/categories' })
  await protectedApp.register(brandRoutes,          { prefix: '/api/brands' })
  await protectedApp.register(expenseRoutes,        { prefix: '/api/expenses' })
  await protectedApp.register(inventoryRoutes,      { prefix: '/api/inventory' })
  await protectedApp.register(staffRoutes,          { prefix: '/api/staff' })
  await protectedApp.register(contractRoutes,       { prefix: '/api/contracts' })
  await protectedApp.register(transportRoutes,      { prefix: '/api/transport' })
  await protectedApp.register(grnRoutes,            { prefix: '/api/grn' })
  await protectedApp.register(broadcastRoutes,      { prefix: '/api/broadcasts' })
  await protectedApp.register(discountRulesRoutes,  { prefix: '/api/discount-rules' })
})

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Close all tenant DB connections cleanly so PostgreSQL doesn't log "unexpected
// EOF" for every open connection when the process exits.
async function shutdown(signal: string) {
  app.log.info(`Received ${signal} — shutting down gracefully`)
  try {
    await app.close()
    const { disconnectAllTenantDbs } = await import('./lib/tenant-db.js')
    await disconnectAllTenantDbs()
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ── Ensure public schema tables exist (idempotent, safe to re-run) ───────────
// These tables may be absent if a Prisma db push --accept-data-loss was run,
// or if the DB was provisioned from an older schema version.
{
  const { db: publicDb } = await import('@billing/db')
  await publicDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash  TEXT        NOT NULL UNIQUE,
      tenant_id   UUID        NOT NULL,
      schema_name TEXT        NOT NULL,
      user_id     UUID        NOT NULL,
      payload     JSONB       NOT NULL DEFAULT '{}',
      user_agent  TEXT,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked     BOOLEAN     NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await publicDb.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash)`)
  // Ensure idempotency_keys has the correct schema (branch_id, endpoint, idempotency_key).
  // An older version used (key, tenant_id) — detect and replace if needed.
  const ikCols = await publicDb.$queryRawUnsafe<{column_name:string}[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_name='idempotency_keys' AND table_schema='public'`
  )
  const ikColNames = ikCols.map(c => c.column_name)
  const requiredIkCols = ['branch_id','endpoint','idempotency_key','response_status','response_body','completed_at']
  if (ikColNames.length > 0 && requiredIkCols.some(c => !ikColNames.includes(c))) {
    // Old schema — drop and recreate
    await publicDb.$executeRawUnsafe(`DROP TABLE IF EXISTS idempotency_keys`)
  }
  await publicDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      branch_id       UUID        NOT NULL,
      endpoint        TEXT        NOT NULL,
      idempotency_key TEXT        NOT NULL,
      status          TEXT        NOT NULL DEFAULT 'processing',
      response_status INTEGER,
      response_body   JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMPTZ,
      UNIQUE (branch_id, endpoint, idempotency_key)
    )
  `)
  await publicDb.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_ik_branch_endpoint ON idempotency_keys(branch_id, endpoint, idempotency_key)`)
}

// ── Start server ──────────────────────────────────────────────────────────────
const port = parseInt(process.env['PORT'] ?? '3000', 10)

try {
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`Server running on http://localhost:${port}`)
  // Small hosting plans have no separate worker service — run the BullMQ workers (PDF, WhatsApp, reminders) in this process.
  if (process.env['RUN_WORKERS_INLINE'] === 'true') await import('./workers/index.js')
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

export { app }
