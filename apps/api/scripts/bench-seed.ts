// apps/api/scripts/bench-seed.ts
// =============================================================================
// Builds a THROWAWAY tenant with realistic volume so list / report speed can be measured:
//   ~40,000 loads · 12,000 trips · 15,000 bills (+ notes) · 10,000 receipts · 80,000 trip costs · 6,000 office costs · 60,000 bank lines
// spread over three years. Data goes in with plain SQL (generate_series), so it takes seconds, not hours.
//
//   cd apps/api && npx tsx --env-file=.env scripts/bench-seed.ts            # creates the tenant (phone 9800000001, PIN 1234)
//   cd apps/api && npx tsx --env-file=.env scripts/bench-seed.ts --drop     # removes it again
// Needs the API running (it registers the tenant through the real endpoint). Never run against a live database.
// =============================================================================

import { sql, prisma } from './_db'

const API = process.env['API_URL'] ?? 'http://localhost:3100'
const PHONE = '9800000001'   // not 7… or 8…: the test suite deletes those
const PIN = '1234'
const SCALE = Number(process.env['SCALE'] ?? 1)

async function api(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  return { status: r.status, data: text ? JSON.parse(text) : null }
}

async function drop() {
  const t = await sql<{ schema_name: string }>(`SELECT "schemaName" AS schema_name FROM public.tenants WHERE "ownerPhone" = $1`, PHONE).catch(() => [])
  for (const r of t) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${r.schema_name}" CASCADE`)
  await prisma.$executeRawUnsafe(`DELETE FROM public.tenants WHERE "ownerPhone" = '${PHONE}'`).catch(() => {})
  console.log('bench tenant removed')
}

async function main() {
  if (process.argv.includes('--drop')) { await drop(); await prisma.$disconnect(); return }

  let login = await api('POST', '/api/auth/login', { tenantPhone: PHONE, phone: PHONE, pin: PIN })
  if (login.status !== 200) {
    const reg = await api('POST', '/api/tenants/register', { businessName: 'Bench Roadlines', ownerName: 'Bench Owner', phone: PHONE, pin: PIN, domainType: 'transport', stateCode: '24', city: 'Surat', lang: 'en' })
    if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.data)}`)
    login = await api('POST', '/api/auth/login', { tenantPhone: PHONE, phone: PHONE, pin: PIN })
  }
  const schema: string = login.data.tenant.schemaName
  const branchId: string = login.data.branch.id
  const userId: string = login.data.user.id
  const S = `"${schema}"`
  const t0 = Date.now()
  const run = async (label: string, q: string) => { const s = Date.now(); await prisma.$executeRawUnsafe(q); console.log(`  ${label.padEnd(22)} ${((Date.now() - s) / 1000).toFixed(1)}s`) }
  const b = `'${branchId}'::uuid`, u = `'${userId}'::uuid`
  const n = (x: number) => Math.round(x * SCALE)

  const have = await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${S}.transport_lorry_receipts WHERE "branchId" = ${b}`)
  if ((have[0]?.n ?? 0) > 5000) { console.log('bench data already there'); await prisma.$disconnect(); return }
  console.log(`Filling ${schema} …`)

  await run('customers + pumps', `
    INSERT INTO ${S}.parties (id, "branchId", type, name, phone, gstin, "creditLimit", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${b}, CASE WHEN g <= ${n(400)} THEN 'customer' ELSE 'supplier' END,
           CASE WHEN g <= ${n(400)} THEN 'Customer ' || g || ' Industries Pvt Ltd' ELSE 'Fuel Pump ' || g END,
           '98' || lpad((g * 7919 % 100000000)::text, 8, '0'), NULL, 5000000, now(), now()
    FROM generate_series(1, ${n(400) + 60}) g`)
  await run('vehicles', `
    INSERT INTO ${S}.transport_vehicles (id, "branchId", "regNo", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${b}, 'GJ' || lpad((g % 40)::text, 2, '0') || 'AB' || lpad(g::text, 4, '0'), now(), now() FROM generate_series(1, ${n(60)}) g`)
  await run('drivers', `
    INSERT INTO ${S}.transport_drivers (id, "branchId", name, "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${b}, 'Driver ' || g, now(), now() FROM generate_series(1, ${n(80)}) g`)

  await run('trips', `
    WITH v AS (SELECT array_agg(id ORDER BY id) a FROM ${S}.transport_vehicles WHERE "branchId" = ${b}),
         d AS (SELECT array_agg(id ORDER BY id) a FROM ${S}.transport_drivers WHERE "branchId" = ${b})
    INSERT INTO ${S}.transport_trips (id, "branchId", "tripNo", "vehicleId", "driverId", "fromCity", "toCity", "startDate", "endDate", status, "startOdometer", "endOdometer", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${b}, 'TRP-B-' || g, v.a[1 + g % array_length(v.a, 1)], d.a[1 + g % array_length(d.a, 1)],
           (ARRAY['Surat','Vapi','Rajkot','Mumbai','Ahmedabad'])[1 + g % 5], (ARRAY['Pune','Delhi','Surat','Kutch','Indore'])[1 + g % 5],
           current_date - (g % 1095), current_date - (g % 1095) + 2, 'completed', 10000 + g * 5, 10000 + g * 5 + 400 + g % 300, now(), now()
    FROM generate_series(1, ${n(12000)}) g, v, d`)

  await run('bills', `
    WITH c AS (SELECT array_agg(id ORDER BY id) a FROM ${S}.parties WHERE "branchId" = ${b} AND type = 'customer')
    INSERT INTO ${S}.invoices (id, "branchId", "createdBy", "txnType", number, date, "dueDate", "partyId", status, "taxableAmt", "cgstTotal", "sgstTotal", "igstTotal", "grandTotal", "paidAmt", "domainData", "createdAt", "updatedAt")
    SELECT uuid_in(md5('bench-inv-' || g)::cstring), ${b}, ${u}, 'sale_invoice', 'B-' || g, current_date - (g % 1095), current_date - (g % 1095) + 30, c.a[1 + g % array_length(c.a, 1)],
           CASE WHEN g % 10 < 6 THEN 'paid' WHEN g % 10 < 8 THEN 'partial' ELSE 'confirmed' END,
           60000 + g % 40000, (60000 + g % 40000) * 0.09, (60000 + g % 40000) * 0.09, 0, (60000 + g % 40000) * 1.18,
           CASE WHEN g % 10 < 6 THEN (60000 + g % 40000) * 1.18 WHEN g % 10 < 8 THEN (60000 + g % 40000) * 0.5 ELSE 0 END,
           jsonb_build_object('bill_kind', 'lr_bill', 'gst_mode', 'forward_18', 'tds_amount', 0), now(), now()
    FROM generate_series(1, ${n(15000)}) g, c`)
  await run('bill lines', `
    INSERT INTO ${S}.invoice_items (id, "invoiceId", description, qty, rate, "taxableAmt", total)
    SELECT gen_random_uuid(), i.id, 'Transportation charge', 1, i."taxableAmt", i."taxableAmt", i."grandTotal" FROM ${S}.invoices i WHERE i."branchId" = ${b} AND i."txnType" = 'sale_invoice'`)
  await run('loads (LR)', `
    WITH c AS (SELECT array_agg(id ORDER BY id) a FROM ${S}.parties WHERE "branchId" = ${b} AND type = 'customer'),
         t AS (SELECT array_agg(id ORDER BY "tripNo") a FROM ${S}.transport_trips WHERE "branchId" = ${b}),
         v AS (SELECT array_agg(id ORDER BY id) a FROM ${S}.transport_vehicles WHERE "branchId" = ${b})
    INSERT INTO ${S}.transport_lorry_receipts (id, "branchId", "lrNo", "lrDate", "consignorId", "consignorName", "consigneeName", "fromCity", "toCity", "goodsDescription",
           "tripId", "vehicleId", "vehicleNo", "invoiceId", status, "freightType", "actualWeightKg", "chargedWeightKg", rate, "rateBasis", "freightAmount", "totalAmount", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${b}, 'LR-B-' || g, current_date - (g % 1095), c.a[1 + g % array_length(c.a, 1)], 'Consignor ' || (g % 400), 'Consignee ' || (g % 900),
           (ARRAY['Surat','Vapi','Rajkot','Mumbai','Ahmedabad'])[1 + g % 5], (ARRAY['Pune','Delhi','Surat','Kutch','Indore'])[1 + g % 5],
           (ARRAY['Fly ash','Cotton bales','Steel bars','Cement bags','Tiles'])[1 + g % 5],
           t.a[1 + g % array_length(t.a, 1)], v.a[1 + g % array_length(v.a, 1)], 'GJ' || lpad((g % 40)::text, 2, '0') || 'AB' || lpad(((g % 60) + 1)::text, 4, '0'),
           CASE WHEN g % 40 < 36 THEN uuid_in(md5('bench-inv-' || (1 + g % ${n(15000)}))::cstring) END,
           CASE WHEN g % 40 < 36 THEN 'billed' WHEN g % 40 < 38 THEN 'delivered' ELSE 'booked' END, 'tbb',
           20000 + g % 5000, 20000 + g % 5000, 1000 + g % 300, 'per_ton', (20 + g % 5) * (1000 + g % 300), (20 + g % 5) * (1000 + g % 300), now(), now()
    FROM generate_series(1, ${n(40000)}) g, c, t, v`)

  await run('receipts', `
    INSERT INTO ${S}.payments (id, "branchId", "partyId", amount, method, type, status, "paymentDate", "refNo", "createdBy", "createdAt")
    SELECT gen_random_uuid(), ${b}, i."partyId", i."paidAmt", (ARRAY['bank_transfer','upi','cheque','cash'])[1 + (row_number() OVER ())::int % 4], 'receipt', 'active', i.date + 12, 'UTR' || row_number() OVER (), ${u}, now()
    FROM ${S}.invoices i WHERE i."branchId" = ${b} AND i."paidAmt" > 0`)
  await run('receipt allocations', `
    INSERT INTO ${S}.payment_allocations (id, "paymentId", "invoiceId", amount)
    SELECT gen_random_uuid(), p.id, i.id, p.amount FROM ${S}.payments p JOIN ${S}.invoices i ON i."partyId" = p."partyId" AND i.date + 12 = p."paymentDate" AND i."paidAmt" = p.amount
    WHERE p."branchId" = ${b}
    ON CONFLICT DO NOTHING`)

  await run('trip costs', `
    WITH t AS (SELECT array_agg(id ORDER BY "tripNo") a, array_agg("vehicleId" ORDER BY "tripNo") vv FROM ${S}.transport_trips WHERE "branchId" = ${b})
    INSERT INTO ${S}.transport_expenses (id, "branchId", "tripId", "vehicleId", category, amount, litres, "ratePerLitre", "expenseDate", "vendorName", "paidBy", "paymentMode", "settledOn", "createdAt")
    SELECT gen_random_uuid(), ${b}, t.a[1 + g % array_length(t.a, 1)], t.vv[1 + g % array_length(t.vv, 1)],
           (ARRAY['diesel','diesel','toll','driver_bhatta','repair','loading_unloading','parking'])[1 + g % 7], 800 + g % 20000, CASE WHEN g % 7 < 2 THEN 100 + g % 200 END, 90,
           current_date - (g % 1095), (ARRAY['Sharma Petrol Pump','Patel Fuel Station','HP Bhagwati Pump','Shell Highway Fuels','Jay Ambe Fuel'])[1 + g % 5],
           CASE WHEN g % 7 < 2 AND g % 3 = 0 THEN 'vendor_credit' WHEN g % 2 = 0 THEN 'driver' ELSE 'company' END, 'cash',
           CASE WHEN g % 7 < 2 AND g % 3 = 0 AND (g % 1095) > 45 THEN current_date - (g % 1095) + 15 END, now()
    FROM generate_series(1, ${n(80000)}) g, t`)
  await run('office costs', `
    INSERT INTO ${S}.expenses (id, "branchId", date, category, amount, "gstAmount", "gstRate", "paymentMode", description, "createdBy", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${b}, current_date - (g % 1095), (ARRAY['rent','electricity','internet','staff','emi','insurance','maintenance','misc'])[1 + g % 8], 1500 + g % 60000, 0, 0, 'bank', 'Bench office cost ' || g, ${u}, now(), now()
    FROM generate_series(1, ${n(6000)}) g`)

  await run('bank account', `INSERT INTO ${S}.bank_accounts (id, "branchId", name) VALUES (gen_random_uuid(), ${b}, 'Bench Current')`)
  await run('bank import', `INSERT INTO ${S}.transport_bank_imports (id, "branchId", "bankAccountId") SELECT gen_random_uuid(), ${b}, id FROM ${S}.bank_accounts WHERE "branchId" = ${b} LIMIT 1`)
  await run('bank lines', `
    WITH a AS (SELECT id FROM ${S}.bank_accounts WHERE "branchId" = ${b} LIMIT 1), im AS (SELECT id FROM ${S}.transport_bank_imports WHERE "branchId" = ${b} LIMIT 1)
    INSERT INTO ${S}.transport_bank_lines (id, "branchId", "bankAccountId", "importId", "txnDate", description, "refNo", debit, credit, balance, status, seq, "dedupeKey", "createdAt")
    SELECT gen_random_uuid(), ${b}, a.id, im.id, current_date - (g % 1095),
           CASE WHEN g % 3 = 0 THEN 'NEFT*UTR' || g || '*CUSTOMER ' || (g % 400) WHEN g % 3 = 1 THEN 'UPI/DR/' || g || '/FUEL PUMP ' || (g % 5) ELSE 'NEFT RENT YARD ' || g END,
           'REF' || g, CASE WHEN g % 3 = 0 THEN 0 ELSE 500 + g % 30000 END, CASE WHEN g % 3 = 0 THEN 500 + g % 90000 ELSE 0 END, 100000 + g,
           CASE WHEN g % 20 < 17 THEN 'matched' WHEN g % 20 < 19 THEN 'unmatched' ELSE 'ignored' END, g, 'bench-' || g, now()
    FROM generate_series(1, ${n(60000)}) g, a, im`)
  await run('statistics', `ANALYZE`)

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Sign in as ${PHONE} / ${PIN}.`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error(String(e.message ?? e).slice(0, 800)); process.exit(1) })
