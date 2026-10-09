// lib/cache.ts
//
// Thin cache-aside wrapper around the shared Redis client.
// Keys are namespaced as `{schemaName}:{branchId}:{qualifier}` so each
// tenant's data is isolated and a whole tenant's cache can be flushed
// with a single SCAN + DEL on `{schemaName}:*`.

import { redis } from './redis.js'

/**
 * Build a cache key scoped to a specific tenant branch.
 * Example: cacheKey('t_krishna_wholesale', 'uuid-123', 'dash', '7d')
 *   → 't_krishna_wholesale:uuid-123:dash:7d'
 */
export function cacheKey(schemaName: string, branchId: string, ...parts: string[]): string {
  return [schemaName, branchId, ...parts].join(':')
}

/**
 * Return cached value if present, otherwise run `fn`, cache the result, and return it.
 * TTL is in seconds.
 */
export async function getOrSet<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  try {
    const cached = await redis.get(key)
    if (cached !== null) return JSON.parse(cached) as T
  } catch {
    // Redis failure must never break the request — fall through to DB
  }

  const result = await fn()

  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(result))
  } catch {
    // Best-effort caching — swallow write errors
  }

  return result
}

/**
 * Invalidate all cache keys for a specific branch.
 * Call this after any write that makes cached data stale.
 */
export async function invalidateBranch(schemaName: string, branchId: string): Promise<void> {
  try {
    const pattern = `${schemaName}:${branchId}:*`
    let cursor = '0'
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = nextCursor
      if (keys.length > 0) await redis.del(...keys)
    } while (cursor !== '0')
  } catch {
    // Non-critical — stale cache is acceptable
  }
}

/**
 * Invalidate specific cache keys for a branch (e.g. after a product write).
 */
export async function invalidateKeys(schemaName: string, branchId: string, ...qualifiers: string[]): Promise<void> {
  try {
    const keys = qualifiers.map(q => cacheKey(schemaName, branchId, q))
    await redis.del(...keys)
  } catch {
    // Non-critical
  }
}
