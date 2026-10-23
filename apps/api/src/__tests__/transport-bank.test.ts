// Bank statements — import, matching, undo, reconciliation. Runs against the live API like transport.test.ts, on
// throw-away tenants (phones 7xxxxxxxxx are purged by globalSetup).

import { newTransportTenant, addStaff, switchFirm, today, type Session } from './helpers'

let seq = 0
const uniq = () => `GJ${String(10 + (seq % 80))}BK${String(Date.now()).slice(-4)}${seq++ % 10}`.slice(0, 12)

describe('Bank statements', () => {
  let biz: Session, manager: Session, cashier: Session, viewer: Session
  let cust: any, acct: any

  beforeAll(async () => {
    biz = await newTransportTenant('Bank Co')
    manager = await addStaff(biz, 'manager')
    cashier = await addStaff(biz, 'cashier')
    viewer = await addStaff(biz, 'viewer')
    cust = (await biz.api.post('/api/parties', { type: 'customer', name: 'Saurastra Cement Ltd', gstin: '24ABICS4135J1Z9', address: { city: 'Ranavav', stateCode: '24' } })).data
  })

  // ── factories ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** A delivered LR billed on its own: 10 t × ₹1000 = ₹10,000 (no GST under RCM), with 1% TDS marked when asked. */
  const mkBill = async (tds = false, party = cust, weightKg = 10000) => {
    const lr = (await biz.api.post('/api/transport/lrs', {
      consignorId: party.id, consigneeName: 'Receiver', fromCity: 'Kutch', toCity: 'Ranavav', goodsDescription: 'Flyash',
      actualWeightKg: weightKg, rateBasis: 'per_ton', rate: 1000,
    })).data
    await biz.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
    const r = await biz.api.post('/api/transport/bills', { partyId: party.id, lrIds: [lr.id], gstMode: 'rcm', tdsApplicable: tds, tdsRatePct: 1 })
    expect(r.status).toBe(201)
    return r.data.invoice
  }
  const stmtRow = (over: Record<string, unknown>) => ({ date: today(-3), description: 'misc', refNo: '', debit: 0, credit: 0, balance: null, ...over })
  const importRows = (rows: any[], s = biz, id = acct.id, fileName = 'stmt.csv') => s.api.post(`/api/transport/bank/accounts/${id}/import`, { fileName, rows })
  const lines = async (qs = '', s = biz) => (await s.api.get(`/api/transport/bank/accounts/${acct.id}/lines?limit=200${qs}`)).data
  const lineWith = async (text: string) => (await lines()).data.find((l: any) => l.description.includes(text))
  const balanceOf = async (id: string) => Number((await biz.api.get(`/api/parties/${id}`)).data.balance)
  const getInvoice = async (id: string) => (await biz.api.get(`/api/invoices/${id}`)).data

  // ═══════════════════════════════════════════════════════════════════════════
  describe('accounts', () => {
    test('a manager adds an account; bad IFSC is refused; staff below manager cannot; the number is masked', async () => {
      expect((await cashier.api.post('/api/transport/bank/accounts', { name: 'X' })).status).toBe(403)
      expect((await viewer.api.post('/api/transport/bank/accounts', { name: 'X' })).status).toBe(403)
      expect((await manager.api.post('/api/transport/bank/accounts', { name: 'Bad', ifscCode: 'NOTANIFSC' })).status).toBe(422)
      const r = await manager.api.post('/api/transport/bank/accounts', { name: 'SBI Current', bankName: 'SBI', accountNumber: '66005054020', ifscCode: 'sbin0060050', openingBalance: 100000 })
      expect(r.status).toBe(201)
      expect(r.data).toMatchObject({ name: 'SBI Current', accountMask: 'XXXX4020', ifscCode: 'SBIN0060050' })
      expect(r.data.accountNumber).toBeUndefined()
      acct = r.data
      const list = (await viewer.api.get('/api/transport/bank/accounts')).data           // anyone can look
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ id: acct.id, lines: 0, unmatched: 0, openingBalance: 100000 })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('importing a statement', () => {
    const base = [
      stmtRow({ date: today(-10), description: 'OPENING TEST ENTRY a', credit: 111, balance: 100111 }),
      stmtRow({ date: today(-9), description: 'UPI/DR/628812345678/TWIN', debit: 50, balance: 100061 }),
      stmtRow({ date: today(-9), description: 'UPI/DR/628812345678/TWIN', debit: 50, balance: 100011 }),     // a genuine twin
    ]

    test('lines are saved oldest first, references are pulled out of the narration, twins are kept', async () => {
      const r = await importRows(base)
      expect(r.status).toBe(201)
      expect(r.data).toMatchObject({ rows: 3, added: 3, duplicates: 0 })
      const l = (await lines()).data
      expect(l).toHaveLength(3)
      const twin = l.filter((x: any) => x.description.includes('TWIN'))
      expect(twin).toHaveLength(2)
      expect(twin[0].refNo).toBe('628812345678')
    })

    test('importing the same file again adds nothing; an overlapping file adds only the new lines', async () => {
      const again = await importRows(base)
      expect(again.data).toMatchObject({ added: 0, duplicates: 3 })
      const more = await importRows([...base, stmtRow({ date: today(-8), description: 'NEW LINE ONLY', credit: 5, balance: 100016 })])
      expect(more.data).toMatchObject({ added: 1, duplicates: 3 })
      expect((await lines()).total).toBe(4)
    })

    test('bad input is refused with the line number; viewers and other tenants cannot import', async () => {
      const both = await importRows([stmtRow({ debit: 5, credit: 6 })])
      expect(both.status).toBe(422)
      expect((await importRows([stmtRow({ date: '2099-01-01', debit: 5 })])).status).toBe(422)
      expect((await importRows([])).status).toBe(422)
      expect((await importRows([stmtRow({ debit: 0, credit: 0 })])).status).toBe(422)              // nothing but empty lines
      expect((await importRows([stmtRow({ debit: 5 })], viewer)).status).toBe(403)
      const stranger = await newTransportTenant('Stranger')
      expect((await importRows([stmtRow({ debit: 5 })], stranger)).status).toBe(404)
      expect((await stranger.api.get(`/api/transport/bank/accounts/${acct.id}/lines`)).status).toBe(404)
    })

    test('filters: status, direction, text and amount', async () => {
      expect((await lines('&direction=in')).data.every((l: any) => l.credit > 0)).toBe(true)
      expect((await lines('&search=NEW%20LINE')).total).toBe(1)
      expect((await lines('&search=111')).total).toBeGreaterThanOrEqual(1)
      const l = await lines('&status=unmatched')
      expect(l.totals.unmatched.count).toBe(4)
    })

    test('an import nothing has touched can be undone; one with a matched line cannot', async () => {
      const fresh = await importRows([stmtRow({ date: today(-7), description: 'UNDO ME', debit: 7, balance: 1 })], biz, acct.id, 'undo.csv')
      expect((await manager.api.delete(`/api/transport/bank/imports/${fresh.data.importId}`)).data.removedLines).toBe(1)
      expect((await lines()).data.find((l: any) => l.description === 'UNDO ME')).toBeUndefined()

      const keep = await importRows([stmtRow({ date: today(-7), description: 'KEEP ME', debit: 8, balance: 2 })], biz, acct.id, 'keep.csv')
      const line = await lineWith('KEEP ME')
      expect((await biz.api.post(`/api/transport/bank/lines/${line.id}/match`, { kind: 'other', label: 'Bank charges' })).status).toBe(200)
      const blocked = await manager.api.delete(`/api/transport/bank/imports/${keep.data.importId}`)
      expect(blocked.status).toBe(409)
      expect((await cashier.api.delete(`/api/transport/bank/imports/${keep.data.importId}`)).status).toBe(403)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('customer receipts', () => {
    test('a credit becomes a receipt against the bill, with the TDS the customer cut — and undoing reverses all of it', async () => {
      const inv = await mkBill(true)                                  // ₹10,000, TDS 1% = ₹100
      expect(Number(inv.grandTotal)).toBe(10000)
      const before = await balanceOf(cust.id)
      await importRows([stmtRow({ date: today(-2), description: 'NEFT*UTIBN26100612345*SAURASTRA CEMENT LTD', credit: 9900, balance: 200000 })])
      const line = await lineWith('SAURASTRA CEMENT')
      expect(line.refNo).toBe('UTIBN26100612345')

      // the screen offers the customer first, because the narration names them
      const sug = (await biz.api.get(`/api/transport/bank/lines/${line.id}/suggestions`)).data
      expect(sug.direction).toBe('in')
      expect(sug.customers[0]).toMatchObject({ id: cust.id })

      expect((await cashier.api.post(`/api/transport/bank/lines/${line.id}/match`, { kind: 'receipt', partyId: cust.id, allocations: [{ invoiceId: inv.id, amount: 9900, tds: 100 }] })).status).toBe(200)

      const paid = await getInvoice(inv.id)
      expect(paid.status).toBe('paid')
      expect(Number(paid.paidAmt)).toBe(10000)
      expect(await balanceOf(cust.id)).toBeCloseTo(before - 10000, 2)
      const done = await lineWith('SAURASTRA CEMENT')
      expect(done).toMatchObject({ status: 'matched', matchKind: 'receipt', createdEntries: true })
      expect(done.paymentIds).toHaveLength(2)                         // the bank amount and the TDS
      expect(done.matchedTo).toMatch(/Receipt from Saurastra/)
      expect((await biz.api.post(`/api/transport/bank/lines/${line.id}/match`, { kind: 'other', label: 'Other' })).status).toBe(409)

      // reversing a receipt that was created from the line needs a manager
      expect((await cashier.api.post(`/api/transport/bank/lines/${line.id}/unmatch`)).status).toBe(403)
      expect((await manager.api.post(`/api/transport/bank/lines/${line.id}/unmatch`)).data.status).toBe('unmatched')
      const back = await getInvoice(inv.id)
      expect(Number(back.paidAmt)).toBe(0)
      expect(back.status).toBe('confirmed')
      expect(await balanceOf(cust.id)).toBeCloseTo(before, 2)
    })

    test('a receipt cannot exceed the bank amount, use another customer\'s bill, or go to a money-out line', async () => {
      const inv = await mkBill()
      await importRows([stmtRow({ date: today(-2), description: 'CREDIT 4000 TEST', credit: 4000, balance: 1 }), stmtRow({ date: today(-2), description: 'DEBIT 4000 TEST', debit: 4000, balance: 2 })])
      const credit = await lineWith('CREDIT 4000'), debit = await lineWith('DEBIT 4000')
      const other = (await biz.api.post('/api/parties', { type: 'customer', name: 'Other Buyer', address: { stateCode: '24' } })).data

      const tooMuch = await biz.api.post(`/api/transport/bank/lines/${credit.id}/match`, { kind: 'receipt', partyId: cust.id, allocations: [{ invoiceId: inv.id, amount: 5000 }] })
      expect(tooMuch.status).toBe(422)
      const wrongParty = await biz.api.post(`/api/transport/bank/lines/${credit.id}/match`, { kind: 'receipt', partyId: other.id, allocations: [{ invoiceId: inv.id, amount: 4000 }] })
      expect(wrongParty.status).toBe(422)
      const wrongWay = await biz.api.post(`/api/transport/bank/lines/${debit.id}/match`, { kind: 'receipt', partyId: cust.id, allocations: [{ invoiceId: inv.id, amount: 4000 }] })
      expect(wrongWay.status).toBe(422)
      expect((await getInvoice(inv.id)).status).toBe('confirmed')       // nothing leaked from the failed attempts
      expect((await lineWith('CREDIT 4000')).status).toBe('unmatched')

      // part to a bill, the rest stays with the customer as an advance
      const part = await biz.api.post(`/api/transport/bank/lines/${credit.id}/match`, { kind: 'receipt', partyId: cust.id, allocations: [{ invoiceId: inv.id, amount: 3000 }] })
      expect(part.status).toBe(200)
      expect(Number((await getInvoice(inv.id)).paidAmt)).toBe(3000)
      expect(part.data.paymentIds).toHaveLength(2)                      // ₹3,000 on the bill + ₹1,000 advance
      await manager.api.post(`/api/transport/bank/lines/${credit.id}/unmatch`)
    })

    test('a receipt typed earlier is linked, not duplicated; auto-match finds it from the reference', async () => {
      const inv = await mkBill()
      const pay = await biz.api.post('/api/payments', {
        partyId: cust.id, amount: 6000, method: 'bank_transfer', refNo: 'UTR998877665544', paymentDate: today(-1),
        allocations: [{ invoiceId: inv.id, amount: 6000 }],
      })
      expect(pay.status).toBe(201)
      await importRows([stmtRow({ date: today(-1), description: 'NEFT-UTR998877665544-SAURASTRA', credit: 6000, balance: 300000 })])
      const line = await lineWith('UTR998877665544')

      const sug = (await biz.api.get(`/api/transport/bank/lines/${line.id}/suggestions`)).data
      expect(sug.payments[0]).toMatchObject({ paymentIds: [pay.data.id], amount: 6000 })
      expect(sug.payments[0].score).toBeGreaterThanOrEqual(90)

      const auto = (await biz.api.post(`/api/transport/bank/accounts/${acct.id}/auto-match`)).data
      expect(auto.receipts).toBeGreaterThanOrEqual(1)
      const done = await lineWith('UTR998877665544')
      expect(done).toMatchObject({ status: 'matched', matchKind: 'receipt', createdEntries: false, paymentIds: [pay.data.id] })

      // linking creates nothing, so undoing it leaves the receipt alone
      await biz.api.post(`/api/transport/bank/lines/${line.id}/unmatch`)
      expect(Number((await getInvoice(inv.id)).paidAmt)).toBe(6000)
      // …and the same payment cannot now be linked twice
      await importRows([stmtRow({ date: today(-1), description: 'SECOND 6000', credit: 6000, balance: 300001 })])
      const l1 = await lineWith('UTR998877665544'), l2 = await lineWith('SECOND 6000')
      expect((await biz.api.post(`/api/transport/bank/lines/${l1.id}/match`, { kind: 'link_payments', paymentIds: [pay.data.id] })).status).toBe(200)
      expect((await biz.api.post(`/api/transport/bank/lines/${l2.id}/match`, { kind: 'link_payments', paymentIds: [pay.data.id] })).status).toBe(422)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('paying pumps, expenses and other lines', () => {
    let tripId: string
    const bills: any[] = []
    beforeAll(async () => {
      const v = (await biz.api.post('/api/transport/vehicles', { regNo: uniq(), vehicleType: 'hcv', capacityTons: 25, currentOdometer: 1000 })).data
      tripId = (await biz.api.post('/api/transport/trips', { vehicleId: v.id, fromCity: 'Kutch', toCity: 'Ranavav' })).data.id
      for (const [i, amount] of [4000, 3000, 2000].entries())
        bills.push((await biz.api.post('/api/transport/expenses', {
          tripId, category: 'diesel', amount, paidBy: 'vendor_credit', vendorName: 'Sharma Petrol Pump', paymentMode: 'credit', expenseDate: today(-30 + i),
        })).data)
    })
    const owed = async () => Number((await biz.api.get('/api/transport/expenses/payables')).data.totalPayable)

    test('a payment to a pump settles its oldest bills that fit; undoing makes them owed again', async () => {
      await importRows([stmtRow({ date: today(-1), description: 'UPI/DR/628812345600/SHARMA PET/SBIN', debit: 7000, balance: 100 })])
      const line = await lineWith('SHARMA PET')
      const sug = (await biz.api.get(`/api/transport/bank/lines/${line.id}/suggestions`)).data
      expect(sug.direction).toBe('out')
      expect(sug.pumps[0]).toMatchObject({ vendor: 'Sharma Petrol Pump', exact: true, pickTotal: 7000 })

      const start = await owed()
      expect((await biz.api.post(`/api/transport/bank/lines/${line.id}/match`, { kind: 'pump', vendor: 'sharma petrol pump', expenseIds: bills.map((b) => b.id) })).status).toBe(422)   // all three = 9000 > 7000
      expect(await owed()).toBe(start)                                  // the refused attempt settled nothing
      const ok = await biz.api.post(`/api/transport/bank/lines/${line.id}/match`, { kind: 'pump', vendor: 'Sharma Petrol Pump' })
      expect(ok.status).toBe(200)
      expect(ok.data.tripExpenseIds).toHaveLength(2)
      expect(ok.data.matchedTo).toMatch(/Paid Sharma Petrol Pump \(2 bills\)/)
      expect(await owed()).toBe(start - 7000)

      expect((await manager.api.post(`/api/transport/bank/lines/${line.id}/unmatch`)).data.status).toBe('unmatched')
      expect(await owed()).toBe(start)
    })

    test('an office expense is created from the line and removed again on undo', async () => {
      await importRows([stmtRow({ date: today(-1), description: 'FASTAG RECHARGE ICICI', debit: 1500, balance: 50 })])
      const line = await lineWith('FASTAG RECHARGE')
      const m = await biz.api.post(`/api/transport/bank/lines/${line.id}/match`, { kind: 'expense', category: 'toll_fastag', description: 'FASTag recharge' })
      expect(m.status).toBe(200)
      expect(m.data.coreExpenseId).toBeTruthy()
      const exp = (await biz.api.get(`/api/expenses/${m.data.coreExpenseId}`)).data
      expect(Number(exp.amount)).toBe(1500)
      expect(exp.paymentMode).toBe('bank')
      expect(m.data.matchedTo).toMatch(/Expense — toll_fastag/)
      await manager.api.post(`/api/transport/bank/lines/${line.id}/unmatch`)
      expect((await biz.api.get(`/api/expenses/${m.data.coreExpenseId}`)).status).toBe(404)
    })

    test('an expense already entered is linked by amount', async () => {
      const e = (await biz.api.post('/api/expenses', { category: 'insurance', amount: 12345, paymentMode: 'bank', date: today(-2) })).data
      await importRows([stmtRow({ date: today(-2), description: 'NEFT INSURANCE PREMIUM', debit: 12345, balance: 40 })])
      const line = await lineWith('INSURANCE PREMIUM')
      const sug = (await biz.api.get(`/api/transport/bank/lines/${line.id}/suggestions`)).data
      expect(sug.expenses.map((x: any) => x.id)).toContain(e.id)
      const m = await biz.api.post(`/api/transport/bank/lines/${line.id}/match`, { kind: 'link_expense', expenseId: e.id })
      expect(m.status).toBe(200)
      await biz.api.post(`/api/transport/bank/lines/${line.id}/unmatch`)
      expect((await biz.api.get(`/api/expenses/${e.id}`)).status).toBe(200)       // linking made nothing, so unlinking deletes nothing
    })

    test('labels classify the rest; unknown labels are refused; lines can be ignored and brought back', async () => {
      await importRows([stmtRow({ date: today(-1), description: 'SELF CHEQUE WITHDRAWAL', debit: 20000, balance: 30 }), stmtRow({ date: today(-1), description: 'SMS CHARGES', debit: 12, balance: 18 })])
      const a = await lineWith('SELF CHEQUE'), b = await lineWith('SMS CHARGES')
      expect((await biz.api.post(`/api/transport/bank/lines/${a.id}/match`, { kind: 'other', label: 'Mystery' })).status).toBe(422)
      const ok = await biz.api.post(`/api/transport/bank/lines/${a.id}/match`, { kind: 'other', label: 'Owner drawings' })
      expect(ok.data).toMatchObject({ status: 'matched', matchKind: 'other', label: 'Owner drawings', matchedTo: 'Owner drawings' })

      expect((await biz.api.post(`/api/transport/bank/lines/${b.id}/ignore`, { reason: 'tiny' })).data.status).toBe('ignored')
      expect((await biz.api.post(`/api/transport/bank/lines/${b.id}/ignore`, {})).status).toBe(409)       // already ignored
      expect((await biz.api.post(`/api/transport/bank/lines/${b.id}/unignore`)).data.status).toBe('unmatched')
      expect((await viewer.api.post(`/api/transport/bank/lines/${b.id}/ignore`, {})).status).toBe(403)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('reconciliation', () => {
    test('books vs bank: what the bank has that the books lack, and what the books have that the bank lacks', async () => {
      // a receipt recorded in the books that no statement line explains
      await biz.api.post('/api/payments', { partyId: cust.id, amount: 777, method: 'upi', refNo: 'NOTINBANK', paymentDate: today(-1) })
      const r = (await viewer.api.get(`/api/transport/bank/accounts/${acct.id}/reconciliation`)).data
      expect(r.account.id).toBe(acct.id)
      expect(r.statement.lines).toBeGreaterThan(5)
      expect(r.unmatched.count).toBe(r.inBankNotInBooks.length)
      expect(r.matched.count).toBeGreaterThan(0)
      expect(r.inBooksNotInBank.map((p: any) => p.refNo)).toContain('NOTINBANK')
      expect(r.inBooksNotInBankTotal).toBeGreaterThanOrEqual(777)
      // the statement's own arithmetic: opening + in − out = the closing balance it prints, when the file is complete
      expect(typeof r.check.expectedClosing).toBe('number')
    })

    test('a complete statement ties out to zero difference', async () => {
      const acc = (await biz.api.post('/api/transport/bank/accounts', { name: 'Axis', openingBalance: 1000 })).data
      const res = await biz.api.post(`/api/transport/bank/accounts/${acc.id}/import`, { fileName: 'axis.csv', rows: [
        stmtRow({ date: today(-5), description: 'in', credit: 500, balance: 1500 }),
        stmtRow({ date: today(-4), description: 'out', debit: 200, balance: 1300 }),
      ] })
      expect(res.status).toBe(201)
      const r = (await biz.api.get(`/api/transport/bank/accounts/${acc.id}/reconciliation?from=${today(-6)}&to=${today(0)}`)).data
      expect(r.statement).toMatchObject({ opening: 1000, credits: 500, debits: 200, closing: 1300 })
      expect(r.check).toEqual({ expectedClosing: 1300, statementClosing: 1300, difference: 0 })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('firms keep their own banks', () => {
    test('another firm of the same owner sees none of this firm\'s accounts or lines', async () => {
      const f = await biz.api.post('/api/transport/firms', { name: 'Second Firm Trading', kind: 'goods', stateCode: '24' })
      expect(f.status).toBe(201)
      const other = await switchFirm(biz, f.data.id)
      expect((await other.api.get('/api/transport/bank/accounts')).data).toEqual([])
      expect((await other.api.get(`/api/transport/bank/accounts/${acct.id}/lines`)).status).toBe(404)
      expect((await other.api.post(`/api/transport/bank/accounts/${acct.id}/import`, { rows: [stmtRow({ debit: 1 })] })).status).toBe(404)
    })
  })
})
