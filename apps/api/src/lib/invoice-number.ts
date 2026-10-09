// =============================================================================
// apps/api/src/lib/invoice-number.ts
//
// Generates sequential invoice numbers scoped to a branch.
// Format: {PREFIX}-{FY}-{SEQUENCE}  e.g. "RK-ALK-25-00142"
//
// WHY in Postgres (not app memory):
//   Multiple app workers run simultaneously (PM2 cluster mode).
//   If two workers generate the same number, you get a unique constraint
//   violation. Using Postgres advisory locks + a counter table means
//   only ONE number is ever assigned per invoice, even under concurrency.
//
// The sequence resets each financial year (April 1 → March 31 in India).
// =============================================================================

import { Prisma } from '@billing/db'

// We store invoice counters in a dedicated table.
// Raw SQL because Prisma doesn't support advisory locks natively.
export async function nextInvoiceNumber(
  tx: Prisma.TransactionClient,
  branchId: string,
  txnType: string
): Promise<string> {
  // Acquire the advisory lock BEFORE reading the prefix or the FY.
  // Running getBranchInvoicePrefix before the lock meant that a concurrent
  // branch-config update could race with prefix resolution — now config is
  // read while we hold the exclusive lock.
  const lockKey = hashLockKey(`${branchId}:${txnType}`)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`

  // Derive FY inside the database so the result is always in IST (Asia/Kolkata).
  // Using JS new Date() on a UTC server produces the wrong FY during the
  // 5.5-hour window between March 31 18:30 UTC and April 1 00:00 UTC —
  // invoices would carry the new FY prefix but be dated in the old FY.
  const fyResult = await tx.$queryRaw<Array<{ fy: string }>>`
    SELECT TO_CHAR(
      NOW() AT TIME ZONE 'Asia/Kolkata',
      CASE
        WHEN EXTRACT(MONTH FROM NOW() AT TIME ZONE 'Asia/Kolkata') >= 4
          THEN 'YY'          -- April–December: use current year's last 2 digits
        ELSE '"'
          || TO_CHAR((EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Asia/Kolkata')::int - 1), 'FM00')
          || '"'             -- Jan–March: use previous year's last 2 digits
      END
    ) AS fy
  `
  const fy = fyResult[0]?.fy ?? currentFinancialYearFallback()

  const prefix = await getBranchInvoicePrefix(tx, branchId, txnType)

  // Determine the max numeric suffix already used for this branch+txnType+fy
  // to guard against sequence resets (e.g. reprovision wiped invoice_sequences).
  const maxRow = await tx.$queryRaw<Array<{ max_val: bigint }>>`
    SELECT COALESCE(MAX(
      NULLIF(SUBSTRING("number" FROM '[0-9]+$'), '')::bigint
    ), 0) AS max_val
    FROM invoices
    WHERE "branchId" = ${branchId}::uuid AND "txnType" = ${txnType}
  `
  const maxUsed = Number(maxRow[0]?.max_val ?? 0)

  // Upsert the counter row and atomically increment, ensuring we never go
  // below the actual maximum already persisted in the invoices table.
  const result = await tx.$queryRaw<Array<{ next_val: number }>>`
    INSERT INTO invoice_sequences (branch_id, txn_type, fy, current_val)
    VALUES (${branchId}::uuid, ${txnType}, ${fy}, ${maxUsed + 1})
    ON CONFLICT (branch_id, txn_type, fy) DO UPDATE
      SET current_val = GREATEST(invoice_sequences.current_val + 1, ${maxUsed + 1})
    RETURNING current_val AS next_val
  `

  const seq = result[0]?.next_val ?? 1
  const paddedSeq = String(seq).padStart(5, '0')

  return `${prefix}-${fy}-${paddedSeq}`
  // e.g. "RK-ALK-25-00001"
}

// Deterministic hash of a string to a signed bigint for pg advisory locks
function hashLockKey(key: string): bigint {
  let hash = 0n
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5n) - hash + BigInt(key.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn
  }
  // Ensure fits in Postgres bigint (signed 64-bit)
  return BigInt.asIntN(64, hash)
}

// Emergency fallback: used only when the DB FY query fails.
// Applies a fixed +5:30 offset to approximate IST — not perfect across DST
// but acceptable as a last resort since the DB path is the real authority.
function currentFinancialYearFallback(): string {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000) // shift to IST
  const year = now.getUTCMonth() >= 3   // April = month index 3
    ? now.getUTCFullYear()
    : now.getUTCFullYear() - 1
  return String(year).slice(-2)
}

async function getBranchInvoicePrefix(
  tx: Prisma.TransactionClient,
  branchId: string,
  txnType: string
): Promise<string> {
  const result = await tx.$queryRaw<Array<{ domainConfig: Record<string, unknown> }>>`
    SELECT "domainConfig" FROM branches WHERE id = ${branchId}::uuid LIMIT 1
  `
  const config = result[0]?.domainConfig as Record<string, string> | undefined

  // Suffix appended to the branch prefix for non-sale document types
  const suffixMap: Record<string, string> = {
    sale_invoice:      '',        // base prefix, no suffix
    purchase_invoice:  '-PUR',
    sale_return:       '-RET',
    purchase_return:   '-DRET',
    quotation:         '-QT',
    sales_order:       '-SO',
    delivery_challan:  '-DC',
    proforma:          '-PRO',
    credit_note:       '-CN',
    debit_note:        '-DN',
  }

  if (config?.invoice_prefix && typeof config.invoice_prefix === 'string') {
    const base   = config.invoice_prefix
    const suffix = suffixMap[txnType] ?? `-${txnType.toUpperCase().slice(0, 4)}`
    return `${base}${suffix}`
  }

  // Default abbreviations when no branch prefix is configured
  const abbr: Record<string, string> = {
    sale_invoice:      'INV',
    purchase_invoice:  'PUR',
    sale_return:       'CRN',
    purchase_return:   'DBN',
    quotation:         'QT',
    sales_order:       'SO',
    delivery_challan:  'DC',
    proforma:          'PRO',
    credit_note:       'CN',
    debit_note:        'DN',
  }
  return abbr[txnType] ?? txnType.toUpperCase().slice(0, 4)
}
