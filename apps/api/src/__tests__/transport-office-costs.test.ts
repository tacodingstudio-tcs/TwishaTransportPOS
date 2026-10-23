// Office Costs are overhead only — trip costs (diesel, toll, bhatta…) are entered against a trip.

import { newTransportTenant, switchFirm, type Session } from './helpers'

const TRANSPORT = ['rent', 'electricity', 'internet', 'staff', 'emi', 'insurance', 'permit_tax', 'maintenance', 'challan', 'misc']
const GOODS = ['electricity', 'internet', 'staff', 'emi', 'insurance', 'maintenance', 'misc']

describe('office costs are overhead only', () => {
  let biz: Session, goods: Session

  beforeAll(async () => {
    biz = await newTransportTenant('Overhead Co')
    const r = await biz.api.post('/api/transport/firms', { name: 'Overhead Goods', kind: 'goods' })
    expect(r.status).toBe(201)
    goods = await switchFirm(biz, r.data.id ?? r.data.firm?.id)
  })

  const codes = async (s: Session) => (await s.api.get('/api/expenses/categories')).data.map((c: any) => c.code).sort()

  test('a transport firm is offered only genuine overhead; a goods firm an even shorter list', async () => {
    expect(await codes(biz)).toEqual([...TRANSPORT].sort())
    expect(await codes(goods)).toEqual([...GOODS].sort())
  })

  test('a trip cost cannot be entered as an office cost, but overhead can', async () => {
    for (const category of ['diesel', 'toll', 'driver_bhatta', 'tyres', 'repair', 'parking']) {
      const r = await biz.api.post('/api/expenses', { category, amount: 500 })
      expect(r.status).toBe(422)
      expect(String(r.data.message ?? r.data.error)).toMatch(/trip cost/i)
    }
    const ok = await biz.api.post('/api/expenses', { category: 'rent', amount: 25000, paymentMode: 'bank' })
    expect(ok.status).toBe(201)
    // and an existing office cost cannot be moved into a trip category
    expect((await biz.api.patch(`/api/expenses/${ok.data.id}`, { category: 'toll' })).status).toBe(422)
    expect((await biz.api.patch(`/api/expenses/${ok.data.id}`, { category: 'electricity' })).status).toBe(200)
  })

  test('the goods firm may not use a category that only a trucking firm has', async () => {
    expect((await goods.api.post('/api/expenses', { category: 'challan', amount: 500 })).status).toBe(422)
    expect((await goods.api.post('/api/expenses', { category: 'maintenance', amount: 500, paymentMode: 'cash' })).status).toBe(201)
  })

  test('trip costs still take the full category list', async () => {
    const v = (await biz.api.post('/api/transport/vehicles', { regNo: 'GJ05OC0001', vehicleType: 'hcv', capacityTons: 20 })).data
    const r = await biz.api.post('/api/transport/expenses', { vehicleId: v.id, category: 'diesel', amount: 4000, paidBy: 'company', paymentMode: 'upi' })
    expect(r.status).toBe(201)
  })
})
