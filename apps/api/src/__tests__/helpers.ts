import axios, { AxiosInstance } from 'axios'

export const BASE = process.env['TEST_API_URL'] ?? `http://localhost:${process.env['TEST_API_PORT'] ?? 3100}`

export interface Session {
  api:       AxiosInstance
  branchId:  string
  userId:    string
  token:     string
  tenantPhone: string
}

/** Axios client that never throws on HTTP errors, so tests can assert on status codes. */
function client(token?: string): AxiosInstance {
  return axios.create({
    baseURL: BASE,
    validateStatus: () => true,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

export async function login(phone: string, pin: string, tenantPhone = phone): Promise<Session> {
  const res = await axios.post(`${BASE}/api/auth/login`, { tenantPhone, phone, pin })
  const { accessToken, user, branch } = res.data
  return { api: client(accessToken), branchId: branch.id, userId: user.id, token: accessToken, tenantPhone }
}

let counter = 0
/** Unique 10-digit phone starting with 7 — jest's globalSetup deletes tenants on 7xxxxxxxxx / 8xxxxxxxxx. */
export function testPhone(): string {
  counter += 1
  const tail = `${Date.now()}`.slice(-7) + String(counter).padStart(2, '0')
  return `7${tail}`.slice(0, 10).padEnd(10, '0')
}

/** Registers a brand-new transport tenant (owner PIN 1234) and returns an owner session. */
export async function newTransportTenant(name = 'Test Roadlines'): Promise<Session> {
  const phone = testPhone()
  const reg = await axios.post(`${BASE}/api/tenants/register`, {
    businessName: `${name} ${phone.slice(-4)}`, ownerName: 'Test Owner', phone, pin: '1234',
    domainType: 'transport', stateCode: '24', city: 'Surat', lang: 'en',
  }, { validateStatus: () => true })
  if (reg.status !== 201) throw new Error(`tenant registration failed: ${reg.status} ${JSON.stringify(reg.data)}`)
  return login(phone, '1234')
}

/** Creates a staff user under the owner's tenant and returns their session. */
export async function addStaff(owner: Session, role: 'manager' | 'cashier' | 'viewer'): Promise<Session> {
  const phone = testPhone()
  const r = await owner.api.post('/api/users', { name: `${role} user`, phone, pin: '4321', role })
  if (r.status !== 201) throw new Error(`user creation failed: ${r.status} ${JSON.stringify(r.data)}`)
  return login(phone, '4321', owner.tenantPhone)
}

export const today = (offsetDays = 0): string =>
  new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10)
