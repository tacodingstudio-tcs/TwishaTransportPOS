// Regression tests for shared billing-core bugs found while hardening tyrePlatform and back-ported here:
// read-only viewers, NUL characters, the Bills tabs, unknown ids, advances, attendance, archiving,
// stock adjustments, month validation, credit risk.

import { newTransportTenant, addStaff, today, type Session } from './helpers'

const U = '00000000-0000-4000-8000-0000000000cc'
let n = 0
const phone = () => `96${String(Date.now()).slice(-6)}${String(n++).padStart(2, '0')}`.slice(0, 10)

describe('Billing-core fixes (back-ported)', () => {
  let owner: Session, viewer: Session
  let party: any

  const post = (s: Session, url: string, body?: unknown) =>
    s.api.post(url, body ?? {}, { headers: { 'Idempotency-Key': crypto.randomUUID() } })

  beforeAll(async () => {
    owner = await newTransportTenant('Core Fix Carriers')
    viewer = await addStaff(owner, 'viewer')
    party = (await owner.api.post('/api/parties', { type: 'customer', name: 'Core Fix Customer', phone: phone() })).data
  })

  test('a viewer is read-only on every write route behind the login', async () => {
    expect((await post(viewer, '/api/expenses', { category: 'rent', amount: 100 })).status).toBe(403)
    expect((await post(viewer, '/api/parties', { type: 'customer', name: 'No' })).status).toBe(403)
    expect((await post(viewer, '/api/products', { name: 'No', salePrice: 1 })).status).toBe(403)
    expect((await viewer.api.get('/api/parties')).status).toBe(200)
    expect((await viewer.api.get('/api/transport/lrs')).status).toBe(200)
  })

  test('a NUL character in a query or body is a 400, not a 500', async () => {
    const q = await owner.api.get('/api/parties', { params: { search: 'ab\u0000cd' } })
    expect(q.status).toBe(400)
    const b = await post(owner, '/api/parties', { type: 'customer', name: 'Nul\u0000Name' })
    expect(b.status).toBe(400)
  })

  test('every document tab and status on the Bills screen can be listed', async () => {
    for (const txnType of ['sale_invoice', 'purchase_invoice', 'quotation', 'proforma', 'sales_order', 'delivery_challan',
      'credit_note', 'debit_note', 'sale_return', 'purchase_return']) {
      expect([txnType, (await owner.api.get('/api/invoices', { params: { txnType } })).status]).toEqual([txnType, 200])
    }
    for (const status of ['draft', 'confirmed', 'partial', 'paid', 'cancelled', 'converted']) {
      expect([status, (await owner.api.get('/api/invoices', { params: { status } })).status]).toEqual([status, 200])
    }
  })

  test('unknown ids are 404: invoice, expense, AI reminder draft, credit-risk party', async () => {
    expect((await owner.api.get(`/api/invoices/${U}`)).status).toBe(404)
    expect((await owner.api.get(`/api/expenses/${U}`)).status).toBe(404)
    expect((await post(owner, `/api/ai/reminders/${U}/approve`)).status).toBe(404)
    expect((await owner.api.get(`/api/ai/credit-risk/${U}`)).status).toBe(404)
  })

  test('credit risk answers for a real customer', async () => {
    const r = await owner.api.get(`/api/ai/credit-risk/${party.id}`)
    expect(r.status).toBe(200)
    expect(r.data).toHaveProperty('score')
  })

  test('an advance can be allocated to a bill, and not beyond its amount', async () => {
    const adv = await post(owner, '/api/invoices/advances', { partyId: party.id, amount: 1000, method: 'upi' })
    expect(adv.status).toBe(201)
    const inv = await post(owner, '/api/invoices', {
      txnType: 'sale_invoice', partyId: party.id, domainData: { gst_mode: 'forward_18' },
      items: [{ description: 'Freight Surat → Mumbai', qty: 1, rate: 5000, gstRate: 18, unit: 'trip' }],
    })
    expect(inv.status).toBe(201)
    const ok = await post(owner, `/api/invoices/advances/${adv.data.id}/allocate`, { allocations: [{ invoiceId: inv.data.id, amount: 1000 }] })
    expect(ok.status).toBeLessThan(300)
    const over = await post(owner, `/api/invoices/advances/${adv.data.id}/allocate`, { allocations: [{ invoiceId: inv.data.id, amount: 500 }] })
    expect(over.status).toBeGreaterThanOrEqual(400)
    expect(over.status).toBeLessThan(500)
  })

  test('staff attendance can be marked, and marking the same day again updates it', async () => {
    const me = (await owner.api.get('/api/users/me')).data
    const a = await post(owner, '/api/staff/attendance', { userId: me.id, date: today(), clockIn: '09:30', status: 'present' })
    expect(a.status).toBe(201)
    const again = await post(owner, '/api/staff/attendance', { userId: me.id, date: today(), clockOut: '18:00', status: 'late' })
    expect(again.status).toBe(201)
    const day = (await owner.api.get('/api/staff/attendance', { params: { date: today() } })).data
    expect(JSON.stringify(day)).toContain('late')
  })

  test('a never-sold product with opening stock can be archived; stock adjustment on an untracked item is 422', async () => {
    const p = await post(owner, '/api/products', { name: 'Archive Me', sku: 'ARCH-1', salePrice: 100, openingStock: 5 })
    expect(p.status).toBeLessThan(300)
    expect((await owner.api.delete(`/api/products/${p.data.id}`)).status).toBeLessThan(300)
    const svc = await post(owner, '/api/products', { name: 'Service Only', itemType: 'service', trackStock: false, salePrice: 100 })
    const adj = await post(owner, `/api/products/${svc.data.id}/stock-adjustment`, { qty: 1, reason: 'x' })
    expect(adj.status).toBe(422)
  })

  test('GST month must be a real month', async () => {
    expect((await owner.api.get('/api/analytics/gst-summary', { params: { month: today().slice(0, 7) } })).status).toBe(200)
    expect((await owner.api.get('/api/analytics/gst-summary', { params: { month: '2026-13' } })).status).toBe(422)
  })
})
