// jest-setup.ts — runs before each test FILE (setupFilesAfterEnv)
// 1. Flushes the API server's in-memory tenant PrismaClient cache before each
//    suite so connections from the previous file don't push us over max_connections.
// 2. Patches axios so every axios.create() instance automatically adds a unique
//    Idempotency-Key header to POST requests, satisfying the server-side requirement
//    without touching every individual test helper.

import http from 'http'
import axios from 'axios'
import type { AxiosInstance } from 'axios'

function addIdempotencyInterceptor(instance: AxiosInstance) {
  instance.interceptors.request.use((config) => {
    if (
      config.method?.toLowerCase() === 'post' &&
      config.headers?.['Idempotency-Key'] === undefined &&
      config.headers?.['idempotency-key'] === undefined
    ) {
      config.headers = config.headers ?? {}
      config.headers['Idempotency-Key'] = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    return config
  })
}

// Patch the default axios instance
addIdempotencyInterceptor(axios)

// Patch axios.create so every derived instance inherits the interceptor
const _originalCreate = axios.create.bind(axios)
;(axios as any).create = (config?: any): AxiosInstance => {
  const instance = _originalCreate(config)
  addIdempotencyInterceptor(instance)
  return instance
}

function flushApiDbConnections(): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: Number(process.env['TEST_API_PORT'] ?? 3100), path: '/api/admin/flush-db', method: 'POST' },
      (res) => { res.resume(); res.on('end', () => resolve()) },
    )
    req.on('error', () => resolve()) // server not running — ignore
    req.end()
  })
}

beforeAll(async () => {
  await flushApiDbConnections()
})
