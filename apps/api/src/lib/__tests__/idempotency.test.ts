// apps/api/src/lib/__tests__/idempotency.test.ts
//
// These tests exercise the idempotency_keys table directly against a real
// Postgres connection (via db from @billing/db) rather than mocking it —
// the unique-constraint race behavior being tested IS the database
// behavior, so mocking it would test nothing meaningful.
//
// Requires: docker compose up (local Postgres running), migrations applied
// including idempotency.sql.

import { db } from '@billing/db'
import { withIdempotency, IdempotencyConflictError } from '../idempotency.js'
import { randomUUID } from 'crypto'

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001'

async function setTenantContext() {
  await db.$executeRaw`SELECT set_config('app.tenant_id', ${TEST_TENANT_ID}, true)`
}

beforeEach(async () => {
  await setTenantContext()
})

describe('withIdempotency', () => {

  test('no key provided — operation runs normally every time', async () => {
    let callCount = 0
    const op = async () => { callCount++; return { value: callCount } }

    const r1 = await withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST', key: undefined }, op)
    const r2 = await withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST', key: undefined }, op)

    expect(r1.result.value).toBe(1)
    expect(r2.result.value).toBe(2)  // ran twice — no idempotency requested
    expect(r1.replayed).toBe(false)
    expect(r2.replayed).toBe(false)
  })

  test('same key, sequential calls — second call replays the first result, does not re-run operation', async () => {
    const key = randomUUID()
    let callCount = 0
    const op = async () => { callCount++; return { invoiceNumber: `INV-${callCount}` } }

    const first  = await withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST_SEQ', key }, op)
    const second = await withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST_SEQ', key }, op)

    expect(callCount).toBe(1)                          // operation only actually executed once
    expect(first.replayed).toBe(false)                 // first call was the real one
    expect(second.replayed).toBe(true)                 // second call was a replay
    expect(second.result).toEqual(first.result)         // exact same response returned
    expect(second.result.invoiceNumber).toBe('INV-1')   // not INV-2 — proves no re-run
  })

  test('different keys never collide — each runs independently', async () => {
    let callCount = 0
    const op = async () => { callCount++; return { value: callCount } }

    const r1 = await withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST_DIFF', key: randomUUID() }, op)
    const r2 = await withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST_DIFF', key: randomUUID() }, op)

    expect(callCount).toBe(2)
    expect(r1.result.value).not.toBe(r2.result.value)
  })

  test('same key, different endpoint — does not collide (keys scoped per endpoint)', async () => {
    const key = randomUUID()
    let callCount = 0
    const op = async () => { callCount++; return { value: callCount } }

    const r1 = await withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'ENDPOINT_A', key }, op)
    const r2 = await withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'ENDPOINT_B', key }, op)

    expect(callCount).toBe(2)            // same key, but different endpoint scope — both ran
    expect(r1.replayed).toBe(false)
    expect(r2.replayed).toBe(false)
  })

  test('concurrent requests with the same key — only one wins, the other gets a 409 conflict', async () => {
    const key = randomUUID()
    let callCount = 0

    // Simulate a slow operation (e.g. a real invoice creation with DB writes)
    const slowOp = async () => {
      callCount++
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { value: callCount }
    }

    // Fire both "requests" at the same time, as a flaky mobile retry would
    const results = await Promise.allSettled([
      withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST_RACE', key }, slowOp),
      withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST_RACE', key }, slowOp),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected   = results.filter((r) => r.status === 'rejected')

    // Exactly one request should succeed and run the real operation;
    // the other should be rejected with IdempotencyConflictError —
    // never both succeeding, never both running the underlying operation.
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(callCount).toBe(1)

    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason
    expect(rejectedReason).toBeInstanceOf(IdempotencyConflictError)
  })

  test('a failed operation can be retried with the same key (status does not get stuck on "processing")', async () => {
    const key = randomUUID()
    let attempt = 0

    const flakyOp = async () => {
      attempt++
      if (attempt === 1) throw new Error('Simulated transient failure')
      return { succeeded: true, attempt }
    }

    // First attempt fails
    await expect(
      withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST_RETRY', key }, flakyOp)
    ).rejects.toThrow('Simulated transient failure')

    // Second attempt with the SAME key should be allowed to actually retry,
    // not be blocked by a stuck 'processing' status from the first failure
    const result = await withIdempotency({ branchId: TEST_TENANT_ID, endpoint: 'TEST_RETRY', key }, flakyOp)

    expect(result.replayed).toBe(false)
    expect(result.result.succeeded).toBe(true)
    expect(result.result.attempt).toBe(2)
    expect(attempt).toBe(2)
  })

  test('mobile invoice retry scenario — same localUuid key prevents duplicate invoice creation', async () => {
    // Simulates: mobile app POSTs an invoice, request times out client-side,
    // mobile sync engine retries with the SAME localUuid as Idempotency-Key.
    const localUuid = randomUUID()
    let invoicesCreated = 0

    const simulateCreateInvoice = async () => {
      invoicesCreated++
      return {
        id: randomUUID(),
        number: `INV-25-${String(invoicesCreated).padStart(5, '0')}`,
        grandTotal: 386,
      }
    }

    const firstAttempt  = await withIdempotency(
      { branchId: TEST_TENANT_ID, endpoint: 'POST /invoices', key: localUuid },
      simulateCreateInvoice
    )
    // Network blip — mobile app never saw the response, retries with same key
    const retryAttempt = await withIdempotency(
      { branchId: TEST_TENANT_ID, endpoint: 'POST /invoices', key: localUuid },
      simulateCreateInvoice
    )

    expect(invoicesCreated).toBe(1)  // only ONE invoice actually created server-side
    expect(retryAttempt.result.id).toBe(firstAttempt.result.id)
    expect(retryAttempt.result.number).toBe(firstAttempt.result.number)
  })
})
