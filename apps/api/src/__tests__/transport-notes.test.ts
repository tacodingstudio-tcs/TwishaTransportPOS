// Credit / debit notes against a bill — what each does to the bill, the customer's balance, the registers and GST.

import { newTransportTenant, addStaff, today, type Session } from './helpers'

describe('credit and debit notes', () => {
  let biz: Session, manager: Session, cashier: Session, viewer: Session
  let cust: any, billA: any, billB: any
  let credit: any, debit: any

  const balance = async () => Number((await biz.api.get(`/api/parties/${cust.id}`)).data.balance)
  const invoice = async (id: string) => (await biz.api.get(`/api/invoices/${id}`)).data
  const note = (s: Session, billId: string, body: Record<string, unknown>) => s.api.post(`/api/transport/bills/${billId}/notes`, body)

  beforeAll(async () => {
    biz = await newTransportTenant('Notes Co')
    manager = await addStaff(biz, 'manager')
    cashier = await addStaff(biz, 'cashier')
    viewer = await addStaff(biz, 'viewer')
    cust = (await biz.api.post('/api/parties', { type: 'customer', name: 'Saurastra Cement Ltd', gstin: '24ABICS4135J1Z9', address: { city: 'Ranavav', stateCode: '24' } })).data
    const bill = async (tons: number, gstMode: string) => {
      const lr = (await biz.api.post('/api/transport/lrs', {
        consignorId: cust.id, consigneeName: 'Receiver', fromCity: 'Kutch', toCity: 'Ranavav', goodsDescription: 'Flyash',
        actualWeightKg: tons * 1000, rateBasis: 'per_ton', rate: 1000,
      })).data
      await biz.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const r = await biz.api.post('/api/transport/bills', { partyId: cust.id, lrIds: [lr.id], date: today(-6), gstMode })
      expect(r.status).toBe(201)
      return r.data.invoice
    }
    billA = await bill(10, 'forward_18')     // 10,000 + 1,800 = 11,800
    billB = await bill(5, 'rcm')             // 5,000, no GST charged
  })

  test('a credit note for shortage lowers the bill, its GST and what the customer owes', async () => {
    expect(await balance()).toBe(16800)
    const r = await note(biz, billA.id, { kind: 'credit', amount: 1000, reason: 'shortage', note: '2.5 MT short at unloading' })
    expect(r.status).toBe(201)
    credit = r.data.note
    expect(credit).toMatchObject({ txnType: 'credit_note', grandTotal: expect.anything() })
    expect(Number(credit.taxableAmt)).toBe(1000)
    expect(Number(credit.grandTotal)).toBe(1180)                              // 18% like its bill
    expect(credit.number).toMatch(/\d/)
    expect(r.data.note.appliedToBill).toBe(1180)

    const bill = await invoice(billA.id)
    expect(Number(bill.paidAmt)).toBe(1180)                                   // set against what was still owed
    expect(bill.status).toBe('partial')
    expect(await balance()).toBe(15620)                                       // 16,800 − 1,180
  })

  test('a credit note cannot be larger than its bill, and only a manager or owner can issue one', async () => {
    const tooBig = await note(biz, billA.id, { kind: 'credit', amount: 9500, reason: 'rate_reduction' })
    expect(tooBig.status).toBe(422)
    expect(tooBig.data.message ?? tooBig.data.error).toMatch(/left to credit/)
    expect((await note(cashier, billA.id, { kind: 'credit', amount: 100, reason: 'discount' })).status).toBe(403)
    expect((await note(viewer, billA.id, { kind: 'debit', amount: 100, reason: 'detention' })).status).toBe(403)
    expect((await note(biz, billA.id, { kind: 'credit', amount: 100, reason: 'detention' })).status).toBe(422)      // a debit reason on a credit
    expect((await note(manager, billA.id, { kind: 'credit', amount: 100, reason: 'discount' })).status).toBe(201)
    // that last one is undone so the figures below stay simple
    const list = (await biz.api.get(`/api/transport/bills/${billA.id}/notes`)).data
    const small = list.find((n: any) => n.reason === 'Discount / rebate')
    expect((await biz.api.post(`/api/invoices/${small.id}/cancel`)).status).toBe(200)
    expect(Number((await invoice(billA.id)).paidAmt)).toBe(1180)
    expect(await balance()).toBe(15620)
  })

  test('a debit note for detention raises what is owed, is paid like a bill, and carries the bill\'s GST', async () => {
    const r = await note(cashier, billA.id, { kind: 'debit', amount: 500, reason: 'detention', note: '1 day at the plant' })
    expect(r.status).toBe(201)
    debit = r.data.note
    expect(debit.txnType).toBe('debit_note')
    expect(Number(debit.grandTotal)).toBe(590)
    expect(await balance()).toBe(16210)

    const pay = await biz.api.post('/api/payments', { partyId: cust.id, amount: 590, method: 'cash', allocations: [{ invoiceId: debit.id, amount: 590 }] })
    expect(pay.status).toBe(201)
    expect((await invoice(debit.id)).status).toBe('paid')
    expect(await balance()).toBe(15620)                                       // a receipt on a customer debit note lowers the balance
  })

  test('the notes of a bill are listed with it, and the bill cannot be cancelled while a note stands', async () => {
    const list = (await biz.api.get(`/api/transport/bills/${billA.id}/notes`)).data
    expect(list.map((n: any) => n.txnType).sort()).toEqual(['credit_note', 'credit_note', 'debit_note'])
    expect(list.find((n: any) => n.id === credit.id)).toMatchObject({ reason: 'Shortage / transit loss', grandTotal: 1180, status: 'confirmed' })
    const c = await biz.api.post(`/api/invoices/${billA.id}/cancel`)
    expect([409, 422]).toContain(c.status)
    expect(String(c.data.message ?? c.data.error)).toMatch(/credit \/ debit note|partially paid/i)
  })

  test('cancelling a credit note gives the amount back to its bill, then the bill can be cancelled', async () => {
    const r = await note(biz, billB.id, { kind: 'credit', amount: 500, reason: 'rate_reduction' })
    expect(r.status).toBe(201)
    expect(Number(r.data.note.grandTotal)).toBe(500)                          // RCM bill: no GST on the note either
    expect(Number((await invoice(billB.id)).paidAmt)).toBe(500)

    const blocked = await biz.api.post(`/api/invoices/${billB.id}/cancel`)
    expect(blocked.status).not.toBe(200)
    expect((await biz.api.post(`/api/invoices/${r.data.note.id}/cancel`)).status).toBe(200)
    const back = await invoice(billB.id)
    expect(Number(back.paidAmt)).toBe(0)
    expect(back.status).toBe('confirmed')
    expect(await balance()).toBe(15620)
    expect((await biz.api.post(`/api/invoices/${billB.id}/cancel`)).status).toBe(200)
    expect(await balance()).toBe(10620)
  })

  test('the sales register shows notes (credit as minus) and nets the totals; who-owes-you includes the debit note until paid', async () => {
    const reg = (await biz.api.get('/api/transport/ca/sales-register')).data
    const cr = reg.rows.find((x: any) => x['Invoice no'] === credit.number)
    expect(cr).toMatchObject({ 'Type': 'Credit note', 'Taxable value': -1000, 'Invoice total': -1180, 'Against bill': billA.number, 'Outstanding': 0 })
    const dr = reg.rows.find((x: any) => x['Invoice no'] === debit.number)
    expect(dr).toMatchObject({ 'Type': 'Debit note', 'Taxable value': 500, 'Invoice total': 590, 'Outstanding': 0, 'Against bill': billA.number })
    // bill A 10,000 − 1,000 + 500 = 9,500 (bill B was cancelled)
    expect(reg.totals['Taxable value']).toBe(9500)

    // a second debit note stays unpaid and shows as owed
    const d2 = (await note(biz, billA.id, { kind: 'debit', amount: 200, reason: 'extra_charges' })).data.note
    const owed = (await biz.api.get('/api/transport/ca/outstanding')).data
    expect(owed.rows.map((x: any) => x['Invoice no'])).toEqual(expect.arrayContaining([billA.number, d2.number]))
    expect(owed.rows.find((x: any) => x['Invoice no'] === d2.number)['Outstanding']).toBe(236)
  })

  test('a credit note downloads as its own PDF (not a tax invoice), a single page with no LR statement', async () => {
    const r = await biz.api.get(`/api/transport/bills/${credit.id}/pdf`, { responseType: 'arraybuffer' })
    expect(r.status).toBe(200)
    expect(String(r.headers['content-type'])).toMatch(/pdf/)
    expect(String(r.headers['content-disposition'])).toMatch(/CreditNote-/)
    const buf = Buffer.from(r.data)
    expect(buf.subarray(0, 4).toString()).toBe('%PDF')
    expect((buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1)
    const bill = await biz.api.get(`/api/transport/bills/${billA.id}/pdf`, { responseType: 'arraybuffer' })
    expect(String(bill.headers['content-disposition'])).toMatch(/Bill-/)
  })

  test('GSTR-3B counts a debit note with the outward supplies and a credit note against them', async () => {
    const g = (await biz.api.get('/api/transport/ca/gstr3b')).data
    const outward = g.rows.find((x: any) => x['Section'] === '3.1(a)')
    const less = g.rows.find((x: any) => x['Section'] === 'Less')
    expect(outward['Invoices']).toBe(3)                                       // bill A + two debit notes
    expect(outward['Total tax']).toBeCloseTo(1800 + 90 + 36, 1)
    expect(less['Total tax']).toBeCloseTo(180, 1)
    expect(g.totals['Outward tax (after credit notes)']).toBeCloseTo(1800 + 90 + 36 - 180, 1)
  })
})
