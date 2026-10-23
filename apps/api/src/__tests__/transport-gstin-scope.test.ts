// One taxpayer, two trade names: firms that share a GSTIN can be read together (GSTR-3B summary, TDS register) by the owner.

import { newTransportTenant, addStaff, switchFirm, today, type Session } from './helpers'

const GSTIN = '24AOOPM6042C1Z4'

describe('firms under one GSTIN, read together', () => {
  let biz: Session, goods: Session, manager: Session
  let goodsName: string, mainName: string

  beforeAll(async () => {
    biz = await newTransportTenant('Gstin Co')
    manager = await addStaff(biz, 'manager')
    const p = await biz.api.patch(`/api/branches/${biz.branchId}`, { gstin: GSTIN })
    expect(p.status).toBe(200)
    mainName = (await biz.api.get('/api/transport/firms')).data.firms.find((f: any) => f.id === biz.branchId).name
    goodsName = 'Gstin Goods Trading'
    const f = await biz.api.post('/api/transport/firms', { name: goodsName, kind: 'goods', gstin: GSTIN, stateCode: '24' })
    expect(f.status).toBe(201)
    goods = await switchFirm(biz, f.data.id)

    // Roadways-style freight bill with TDS: 10,000 + 18% GST
    const cust = (await biz.api.post('/api/parties', { type: 'customer', name: 'Saurastra Cement Ltd', gstin: '24ABICS4135J1Z9', pan: 'ABICS4135J', address: { stateCode: '24' } })).data
    const lr = (await biz.api.post('/api/transport/lrs', { consignorId: cust.id, consigneeName: 'Rx', fromCity: 'Kutch', toCity: 'Ranavav', goodsDescription: 'Flyash', actualWeightKg: 10000, rateBasis: 'per_ton', rate: 1000 })).data
    await biz.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
    const bill = await biz.api.post('/api/transport/bills', { partyId: cust.id, lrIds: [lr.id], date: today(-3), gstMode: 'forward_18', tdsApplicable: true, tdsRatePct: 1 })
    expect(bill.status).toBe(201)

    // goods bill in the other name: 35,000 + 5% GST
    const gcust = (await goods.api.post('/api/parties', { type: 'customer', name: 'Saurastra Cement Ltd', gstin: '24ABICS4135J1Z9', pan: 'ABICS4135J', address: { stateCode: '24' } })).data
    const g = await goods.api.post('/api/transport/goods-bills', { partyId: gcust.id, date: today(-2), items: [{ description: 'Flyash', hsnSacCode: '26219000', qty: 100, unit: 'MT', rate: 350, gstRate: 5 }] })
    expect(g.status).toBe(201)
  })

  const get = (s: Session, path: string) => s.api.get(`/api/transport/ca/${path}`)

  test('each firm alone still shows only its own figures', async () => {
    const mine = (await get(biz, 'gstr3b')).data
    expect(mine.rows.find((r: any) => r['Section'] === '3.1(a)')).toMatchObject({ 'Invoices': 1, 'Taxable value': 10000, 'Total tax': 1800 })
    const theirs = (await get(goods, 'gstr3b')).data
    expect(theirs.rows.find((r: any) => r['Section'] === '3.1(a)')).toMatchObject({ 'Invoices': 1, 'Taxable value': 35000, 'Total tax': 1750 })
  })

  test('together: one GSTR-3B for the GSTIN, with a line per trade name', async () => {
    const r = (await get(biz, 'gstr3b?scope=gstin')).data
    expect(r.title).toMatch(/all names under this GSTIN/)
    expect(r.firm.name).toContain(mainName)
    expect(r.firm.name).toContain(goodsName)
    expect(r.rows.find((x: any) => x['Section'] === '3.1(a)')).toMatchObject({ 'Invoices': 2, 'Taxable value': 45000, 'Total tax': 3550 })
    expect(r.totals['Outward tax (after credit notes)']).toBe(3550)
    expect(r.summary).toHaveLength(2)
    expect(r.summary.find((x: any) => x['Firm'] === goodsName)).toMatchObject({ 'Outward bills': 1, 'Outward tax (net of credit notes)': 1750 })
    expect(r.summary.find((x: any) => x['Firm'] === mainName)).toMatchObject({ 'Outward bills': 1, 'Outward tax (net of credit notes)': 1800 })
    // the same answer whichever name the owner is working in
    const other = (await get(goods, 'gstr3b?scope=gstin')).data
    expect(other.totals['Outward tax (after credit notes)']).toBe(3550)
  })

  test('together: the TDS register carries a Firm column and covers both names', async () => {
    const r = (await get(biz, 'tds-register?scope=gstin')).data
    expect(r.title).toMatch(/all names under one PAN/)
    expect(r.columns).toContain('Firm')
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ 'Firm': mainName, 'Customer': 'Saurastra Cement Ltd', 'PAN': 'ABICS4135J', 'TDS deducted by customer': 100 })
    expect((await get(biz, 'tds-register')).data.columns).not.toContain('Firm')          // alone: unchanged
  })

  test('only the owner can read the firms together; a firm with no GSTIN just shows itself', async () => {
    expect((await get(manager, 'gstr3b?scope=gstin')).status).toBe(403)
    expect((await get(manager, 'tds-register?scope=gstin')).status).toBe(403)
    const solo = await newTransportTenant('Solo Co')
    const r = (await get(solo, 'gstr3b?scope=gstin')).data
    expect(r.title).toBe('GSTR-3B summary')
    expect(r.summary).toBeUndefined()
  })
})
