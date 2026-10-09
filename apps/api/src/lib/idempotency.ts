// apps/api/src/lib/idempotency.ts
//
// Wraps any mutating operation (invoice creation, payment recording) with
// idempotency-key protection. Usage pattern:
//
//   const result = await withIdempotency(
//     { branchId, endpoint: 'POST /invoices', key: idempotencyKey },
//     async () => createInvoice(input, ctx)
//   )
//
// If `key` is provided and was already used successfully, the ORIGINAL
// response is returned without re-running the operation — no duplicate
// invoice, no duplicate stock deduction, no duplicate party balance change.
//
// If `key` is provided but currently has status='processing' (a concurrent
// request with the same key is mid-flight — e.g. a mobile app firing the
// same request twice in quick succession before the first completes), this
// throws a 409 rather than letting both requests race through business logic.
//
// If `key` is omitted entirely, the operation just runs normally — idempotency
// is opt-in per request, not mandatory. Web dashboard clicks generally don't
// need it (no automatic retry layer); mobile sync and any client with retry
// logic SHOULD always supply a key.

import { db } from '@billing/db'
import { Prisma } from '@billing/db'

export class IdempotencyConflictError extends Error {
  statusCode = 409
  constructor() {
    super('A request with this idempotency key is already being processed')
  }
}

interface IdempotencyContext {
  branchId: string
  endpoint: string       // e.g. 'POST /invoices' — keeps keys scoped per operation type
  key:      string | undefined
}

export async function withIdempotency<T>(
  ctx: IdempotencyContext,
  operation: () => Promise<T>
): Promise<{ result: T; replayed: boolean }> {
  // No key supplied — idempotency not requested, just run normally.
  if (!ctx.key) {
    const result = await operation()
    return { result, replayed: false }
  }

  // 1. Check for an existing record with this key.
  // Keys older than 24 hours are not replayed — treat as if they never existed
  // so the same key can safely be reused in a new business day.
  // Idempotency keys are stored in the public schema — use the global db client.
  const existing = await db.$queryRaw<Array<{
    status: string; response_status: number | null; response_body: unknown
  }>>`
    SELECT status, response_status, response_body
    FROM idempotency_keys
    WHERE branch_id = ${ctx.branchId}::uuid
      AND endpoint = ${ctx.endpoint}
      AND idempotency_key = ${ctx.key}
      AND created_at > NOW() - INTERVAL '24 hours'
  `

  if (existing.length > 0) {
    const record = existing[0]!

    if (record.status === 'completed') {
      // Exact replay of the original successful response — the caller
      // (e.g. invoice.service.ts) is responsible for returning this
      // instead of running createInvoice again.
      return { result: record.response_body as T, replayed: true }
    }

    if (record.status === 'processing') {
      // A request with this key is currently mid-flight. This happens
      // when a client fires a duplicate request before the first one
      // has finished (e.g. double-tap on a slow connection, or a mobile
      // app's automatic retry firing before the original request timed
      // out server-side). Reject rather than letting both proceed.
      throw new IdempotencyConflictError()
    }
    // status === 'failed' falls through to retry below — a failed
    // attempt should be safely retryable, not permanently blocked.
  }

  // 2. Atomically CLAIM the key before running the operation.
  //    A single INSERT … ON CONFLICT … RETURNING means exactly one concurrent request gets a
  //    row back. (The old "insert, then check the row is 'processing'" let *every* racer pass,
  //    because the winner's row is also 'processing' — duplicates then all ran the operation.)
  //    A previous 'failed' attempt, or a record older than 24h, can be re-claimed.
  const claimed = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO idempotency_keys (branch_id, endpoint, idempotency_key, status)
    VALUES (${ctx.branchId}::uuid, ${ctx.endpoint}, ${ctx.key}, 'processing')
    ON CONFLICT (branch_id, endpoint, idempotency_key)
    DO UPDATE SET status = 'processing', created_at = NOW(), completed_at = NULL,
                  response_status = NULL, response_body = NULL
      WHERE idempotency_keys.status = 'failed'
         OR idempotency_keys.created_at < NOW() - INTERVAL '24 hours'
    RETURNING id
  `

  if (claimed.length === 0) {
    // Someone else holds the key. If they have already finished, replay their result;
    // otherwise they are still mid-flight — reject instead of running a duplicate.
    const now = await db.$queryRaw<Array<{ status: string; response_body: unknown }>>`
      SELECT status, response_body FROM idempotency_keys
      WHERE branch_id = ${ctx.branchId}::uuid
        AND endpoint = ${ctx.endpoint}
        AND idempotency_key = ${ctx.key}
    `
    if (now[0]?.status === 'completed') return { result: now[0].response_body as T, replayed: true }
    throw new IdempotencyConflictError()
  }

  // 3. Run the actual operation.
  try {
    const result = await operation()

    // 4. Mark completed and store the response for future replays.
    await db.$executeRaw`
      UPDATE idempotency_keys
      SET status = 'completed', response_status = 201,
          response_body = ${JSON.stringify(result)}::jsonb,
          completed_at = now()
      WHERE branch_id = ${ctx.branchId}::uuid
        AND endpoint = ${ctx.endpoint}
        AND idempotency_key = ${ctx.key}
    `

    return { result, replayed: false }
  } catch (err) {
    // 5. Mark failed so a retry with the same key is allowed to try again
    //    rather than being permanently stuck as 'processing'.
    await db.$executeRaw`
      UPDATE idempotency_keys
      SET status = 'failed', completed_at = now()
      WHERE branch_id = ${ctx.branchId}::uuid
        AND endpoint = ${ctx.endpoint}
        AND idempotency_key = ${ctx.key}
    `
    throw err
  }
}
