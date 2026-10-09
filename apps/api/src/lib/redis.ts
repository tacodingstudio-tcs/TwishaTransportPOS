import Redis from 'ioredis'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IORedis = (Redis as any).default ?? Redis

// Singleton Redis client — shared across all BullMQ workers and cache calls
export const redis = new IORedis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // Required by BullMQ
  lazyConnect: true,
})

redis.on('error', (err: Error) => {
  console.error('[Redis] Connection error:', err.message)
})

redis.on('connect', () => {
  console.info('[Redis] Connected')
})
