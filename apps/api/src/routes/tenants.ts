// apps/api/src/routes/tenants.ts
// Public route — no auth required (used for self-signup)

import type { FastifyPluginAsync } from 'fastify'
import { z, ZodError } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@billing/db'
import { getTenantDb, schemaFromSlug } from '../lib/tenant-db.js'
import { createTenantSchema, seedDomainCategories } from '../lib/provision-schema.js'
import { partsFor } from '../lib/schema-parts.js'
import { DOMAIN_REGISTRY } from '@billing/domain-registry'
import { hashPin } from '../lib/password.js'

const domainKeys = Object.keys(DOMAIN_REGISTRY) as [string, ...string[]]

// GSTIN: 2-digit state + 10-char PAN + 1 entity + 1 Z + 1 checksum
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/

// Luhn-style GSTIN checksum validation
function isValidGstin(gstin: string): boolean {
  if (!GSTIN_REGEX.test(gstin)) return false
  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(gstin[i]!)
    const m = v * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(m / 36) + (m % 36)
  }
  const check = (36 - (sum % 36)) % 36
  return CHARS[check] === gstin[14]
}

// Indian mobile: 10 digits starting with 6-9 (with optional +91 / 0 prefix)
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0'))  return digits.slice(1)
  return digits
}

const RegisterSchema = z.object({
  businessName: z.string().min(2).max(200).trim(),
  ownerName:    z.string().min(2).max(100).trim(),
  phone:        z.string().transform(normalizePhone).pipe(
    z.string().length(10).regex(/^[6-9]\d{9}$/, 'Must be a valid 10-digit Indian mobile number')
  ),
  pin:          z.string().length(4).regex(/^\d{4}$/, 'PIN must be exactly 4 digits'),
  domainType:   z.enum(domainKeys as [string, ...string[]]).default('transport'),
  gstin:        z.string().trim().toUpperCase().refine(
    v => v === '' || isValidGstin(v),
    { message: 'Invalid GSTIN — check format and checksum (e.g. 24AABCR1234A1Z5)' }
  ).transform(v => v || undefined).optional(),
  city:         z.string().max(100).trim().optional(),
  stateCode:    z.string().length(2).regex(/^\d{2}$/).optional(),
  lang:         z.enum(['hi','en','gu','mr','ta','te','kn','bn']).default('hi'),
})

export const tenantRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/tenants/domains — list all supported domain types ─────────────
  app.get('/domains', async () => {
    return Object.entries(DOMAIN_REGISTRY).map(([key, val]) => ({
      key,
      label:           (val as any).label,
      extensionTables: (val as any).extensionTables,
      features:        (val as any).features,
    }))
  })

  // ── GET /api/tenants/check-phone/:phone — pre-flight duplicate check ────────
  app.get('/check-phone/:phone', async (req, reply) => {
    const raw    = (req.params as { phone: string }).phone
    const phone  = normalizePhone(raw)
    const exists = await db.tenant.findUnique({ where: { ownerPhone: phone }, select: { id: true } })
    return reply.send({ available: !exists })
  })

  // ── GET /api/tenants/gstin/:gstin — GSTIN lookup + format validation ────────
  app.get('/gstin/:gstin', async (req: any, reply) => {
    const gstin = (req.params as { gstin: string }).gstin.toUpperCase().trim()

    if (!isValidGstin(gstin)) {
      return reply.status(400).send({
        error: 'Invalid GSTIN format or checksum',
        hint:  'Format: 2-digit state code + PAN + entity + Z + checksum (e.g. 24AABCR1234A1Z5)',
      })
    }

    const { lookupGSTIN } = await import('../services/gstin.service.js')
    try {
      return await lookupGSTIN(gstin)
    } catch (err: any) {
      return reply.status(err.statusCode ?? 500).send({ error: err.message, code: err.code })
    }
  })

  // ── POST /api/tenants/register ──────────────────────────────────────────────
  // Self-signup — creates isolated tenant schema + branch + owner user.
  // Idempotency: phone is globally unique (ownerPhone UNIQUE constraint).
  app.post('/register', async (req, reply) => {
    // The live site belongs to one client: set ALLOW_SIGNUP=false there so nobody can create a business through the API.
    if (process.env['ALLOW_SIGNUP'] === 'false') return reply.status(403).send({ error: 'Sign-up is closed. Ask your administrator to create an account.' })
    // ── 1. Validate input ────────────────────────────────────────────────────
    let input: z.infer<typeof RegisterSchema>
    try {
      input = RegisterSchema.parse(req.body)
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({
          error:  'Validation failed',
          issues: err.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
        })
      }
      throw err
    }

    // ── 2. Check for duplicate phone before doing any DB writes ─────────────
    const existing = await db.tenant.findUnique({
      where:  { ownerPhone: input.phone },
      select: { id: true, name: true },
    })
    if (existing) {
      return reply.status(409).send({
        error: 'Phone number already registered',
        hint:  'This mobile number is already linked to an account. Use /api/auth/login to sign in.',
      })
    }

    // ── 3. Derive slug + schema name ────────────────────────────────────────
    const baseSlug = input.businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)

    // 4-char random suffix avoids slug collisions without exposing a counter
    const slug       = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`
    const schemaName = schemaFromSlug(slug)

    // ── 4. Create tenant row ─────────────────────────────────────────────────
    let tenant: Awaited<ReturnType<typeof db.tenant.create>>
    try {
      tenant = await db.tenant.create({
        data: {
          name:       input.businessName,
          slug,
          schemaName,
          plan:       'free',
          gstin:      input.gstin ?? null,
          ownerPhone: input.phone,
          settings:   { lang: input.lang, timezone: 'Asia/Kolkata' },
        },
      })
    } catch (err) {
      // Race condition: another request registered the same phone between our check and insert
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? []
        if (target.includes('ownerPhone') || target.includes('slug')) {
          return reply.status(409).send({
            error: target.includes('ownerPhone')
              ? 'Phone number already registered'
              : 'Business name too similar to an existing account — try a slightly different name',
          })
        }
      }
      throw err
    }

    // ── 5. Provision isolated PostgreSQL schema ──────────────────────────────
    try {
      // Build the schema from the parts this domain needs (see lib/schema-parts.ts), then bring it up to date with every
      // table/column migration existing tenants received.
      await createTenantSchema(schemaName, partsFor(input.domainType))
    } catch (schemaErr) {
      // Schema provisioning failed — roll back the tenant row so the phone stays available
      await db.tenant.delete({ where: { id: tenant.id } }).catch(() => {})
      // ...and the half-provisioned schema, so a retry starts clean
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
      throw schemaErr
    }

    // ── 6. Create branch + owner user inside the new schema ─────────────────
    const tdb           = getTenantDb(schemaName)
    const defaultConfig = (DOMAIN_REGISTRY as any)[input.domainType]?.defaultDomainConfig ?? {}
    const invoicePrefix = baseSlug.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase()

    try {
      const branch = await tdb.branch.create({
        data: {
          name:         input.businessName,
          gstin:        input.gstin ?? null,
          stateCode:    input.stateCode ?? null,
          domainType:   input.domainType,
          domainConfig: { ...defaultConfig, invoice_prefix: invoicePrefix },
          address:      input.city
            ? { city: input.city, state: input.stateCode ?? null }
            : undefined,
        },
      })

      await tdb.user.create({
        data: {
          name:      input.ownerName,
          phone:     input.phone,
          role:      'owner',
          branchIds: [],
          pin:       await hashPin(input.pin),
          lang:      input.lang,
        },
      })

      // Pre-seed invoice sequences so the number generator works on first invoice.
      // provision-schema.ts recreates invoice_sequences with snake_case columns
      // (branch_id, txn_type, fy, current_val) matching what invoice-number.ts expects.
      const now = new Date()
      const fy  = now.getMonth() >= 3
        ? String(now.getFullYear()).slice(-2)
        : String(now.getFullYear() - 1).slice(-2)
      await tdb.$executeRawUnsafe(`
        INSERT INTO invoice_sequences (branch_id, txn_type, fy, current_val)
        VALUES
          ('${branch.id}','sale_invoice',     '${fy}', 0),
          ('${branch.id}','purchase_invoice', '${fy}', 0),
          ('${branch.id}','proforma',         '${fy}', 0),
          ('${branch.id}','quotation',        '${fy}', 0),
          ('${branch.id}','credit_note',      '${fy}', 0),
          ('${branch.id}','delivery_challan', '${fy}', 0)
        ON CONFLICT (branch_id, txn_type, fy) DO NOTHING
      `)

      // Seed the default product/service categories for this business type
      await seedDomainCategories(tdb, branch.id, input.domainType)

      return reply.status(201).send({
        message:       'Account created successfully. You can now log in.',
        tenantId:      tenant.id,
        slug:          tenant.slug,
        branchId:      branch.id,
        domainType:    input.domainType,
        invoicePrefix,
        loginWith: {
          endpoint:    'POST /api/auth/login',
          tenantPhone: input.phone,
          phone:       input.phone,
          pin:         '(the PIN you just set)',
        },
      })
    } catch (innerErr) {
      // Branch/user creation failed — drop BOTH the tenant row and the PostgreSQL schema
      // so neither is left orphaned. The phone becomes available for a fresh registration.
      await db.tenant.delete({ where: { id: tenant.id } }).catch(() => {})
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
      throw innerErr
    }
  })
}
