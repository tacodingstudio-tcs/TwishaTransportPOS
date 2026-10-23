// Position-based paging: walking a list with `after` bookmarks gives exactly the same rows, in the same order, as one big page —
// no repeats, no gaps — and only the first page pays for the count.

import { newTransportTenant, today, type Session } from './helpers'

describe('position-based paging (loads, trip costs, bills, bank lines)', () => {
  let biz: Session
  let cust: any, acct: any

  /** Walk a list three at a time following nextCursor; returns the ids in the order met, and how many pages it took. */
  async function walk(path: string, idsOf: (body: any) => string[], cursorOf: (body: any) => string | null, afterParam = 'after') {
    const sep = path.includes('?') ? '&' : '?'
    const seen: string[] = []
    let after: string | null = null, pages = 0, first: any = null
    do {
      const r = await biz.api.get(`${path}${sep}limit=3${after ? `&${afterParam}=${after}` : ''}`)
      expect(r.status).toBe(200)
      if (!first) first = r.data
      seen.push(...idsOf(r.data))
      after = cursorOf(r.data)
      pages++
      expect(pages).toBeLessThan(20)                       // never loops
    } while (after)
    return { seen, pages, first }
  }

  beforeAll(async () => {
    biz = await newTransportTenant('Paging Co')
    cust = (await biz.api.post('/api/parties', { type: 'customer', name: 'Pager Cement Ltd', address: { stateCode: '24' } })).data
    // seven loads on a few different days, so the order has ties to break
    for (let i = 0; i < 7; i++) {
      const r = await biz.api.post('/api/transport/lrs', {
        consignorId: cust.id, consigneeName: `Rx ${i}`, fromCity: 'Surat', toCity: 'Pune', goodsDescription: 'Cotton', actualWeightKg: 1000 + i, rateBasis: 'per_ton', rate: 1000,
        lrDate: today(-(i % 3)),
      })
      expect(r.status).toBe(201)
    }
    const v = (await biz.api.post('/api/transport/vehicles', { regNo: 'GJ05PG0001', vehicleType: 'hcv', capacityTons: 20 })).data
    for (let i = 0; i < 7; i++) {
      const r = await biz.api.post('/api/transport/expenses', { vehicleId: v.id, category: 'diesel', amount: 1000 + i, paidBy: 'company', paymentMode: 'upi', expenseDate: today(-(i % 2)) })
      expect(r.status).toBe(201)
    }
    // five bills, one load each
    const lrs = (await biz.api.get('/api/transport/lrs?limit=5')).data.data
    for (const lr of lrs) {
      await biz.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      expect((await biz.api.post('/api/transport/bills', { partyId: cust.id, lrIds: [lr.id], gstMode: 'rcm', date: today(-1) })).status).toBe(201)
    }
    acct = (await biz.api.post('/api/transport/bank/accounts', { name: 'Paging Bank', openingBalance: 0 })).data
    const rows = Array.from({ length: 7 }, (_, i) => ({ date: today(-(i % 3)), description: `LINE ${i}`, refNo: '', debit: 100 + i, credit: 0, balance: 5000 - i * 100 }))
    expect((await biz.api.post(`/api/transport/bank/accounts/${acct.id}/import`, { rows })).status).toBe(201)
  })

  test('loads: bookmarks give the same rows in the same order as one big page; only the first page counts', async () => {
    const all = (await biz.api.get('/api/transport/lrs?limit=200')).data
    expect(all.data).toHaveLength(7)
    expect(all.nextCursor).toBeNull()
    const w = await walk('/api/transport/lrs', (b) => b.data.map((x: any) => x.id), (b) => b.nextCursor)
    expect(w.seen).toEqual(all.data.map((x: any) => x.id))                       // no repeats, no gaps, same order
    expect(w.pages).toBe(3)                                                      // 3 + 3 + 1
    expect(w.first.total).toBe(7)                                                // the first page carries the count …
    const second = (await biz.api.get(`/api/transport/lrs?limit=3&after=${w.first.nextCursor}`)).data
    expect(second.total).toBeUndefined()                                         // … a bookmarked page does not
    expect(second.data[0]).not.toHaveProperty('_ck')                             // internal bookmark column never leaks
  })

  test('loads: a page number still works for older callers, and a bad bookmark is refused politely', async () => {
    const p2 = (await biz.api.get('/api/transport/lrs?limit=3&page=2')).data
    const viaCursor = (await biz.api.get(`/api/transport/lrs?limit=3&after=${(await biz.api.get('/api/transport/lrs?limit=3')).data.nextCursor}`)).data
    expect(p2.data.map((x: any) => x.id)).toEqual(viaCursor.data.map((x: any) => x.id))
    expect(p2.total).toBe(7)
    const bad = await biz.api.get('/api/transport/lrs?after=not-a-real-marker')
    expect(bad.status).toBe(422)
    expect(String(bad.data.message ?? bad.data.error)).toMatch(/page marker/i)
  })

  test('loads: filters and bookmarks work together', async () => {
    const w = await walk(`/api/transport/lrs?from=${today(-1)}&to=${today(0)}`, (b) => b.data.map((x: any) => x.id), (b) => b.nextCursor)
    const all = (await biz.api.get(`/api/transport/lrs?from=${today(-1)}&to=${today(0)}&limit=200`)).data
    expect(w.seen).toEqual(all.data.map((x: any) => x.id))
    expect(w.seen.length).toBeGreaterThan(3)
  })

  test('trip costs: same rows, same order, count only on the first page', async () => {
    const all = (await biz.api.get('/api/transport/expenses?limit=200')).data
    expect(all.data).toHaveLength(7)
    const w = await walk('/api/transport/expenses', (b) => b.data.map((x: any) => x.id), (b) => b.nextCursor)
    expect(w.seen).toEqual(all.data.map((x: any) => x.id))
    expect(w.first.total).toBe(7)
    expect(w.first.totalAmount).toBeCloseTo(7021, 2)
    expect(w.first.data[0]).not.toHaveProperty('_ck')
  })

  test('bills: Prisma cursor — same bills, same order, and the count only on the first page', async () => {
    const all = (await biz.api.get('/api/invoices?txnType=sale_invoice&limit=100')).data
    expect(all.data).toHaveLength(5)
    const w = await walk('/api/invoices?txnType=sale_invoice', (b) => b.data.map((x: any) => x.id), (b) => b.meta.nextCursor)
    expect(w.seen).toEqual(all.data.map((x: any) => x.id))
    expect(w.first.meta.total).toBe(5)
    const second = (await biz.api.get(`/api/invoices?txnType=sale_invoice&limit=3&after=${w.first.meta.nextCursor}`)).data
    expect(second.meta.total).toBeUndefined()
  })

  test('bank lines: same lines, same order, per-status counts only on the first page', async () => {
    const base = `/api/transport/bank/accounts/${acct.id}/lines`
    const all = (await biz.api.get(`${base}?limit=200`)).data
    expect(all.data).toHaveLength(7)
    const w = await walk(base, (b) => b.data.map((x: any) => x.id), (b) => b.nextCursor)
    expect(w.seen).toEqual(all.data.map((x: any) => x.id))
    expect(w.first.total).toBe(7)
    expect(w.first.totals.unmatched.count).toBe(7)
    const second = (await biz.api.get(`${base}?limit=3&after=${w.first.nextCursor}`)).data
    expect(second.totals).toBeUndefined()
    expect(second.data[0]).not.toHaveProperty('_td')
  })
})
