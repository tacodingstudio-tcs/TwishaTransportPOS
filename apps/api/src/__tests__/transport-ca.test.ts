// CA reports — registers, TDS, GSTR-3B summary, pump ledger, receivables, bank book, combined firms.
// One scenario, built through the real API, then every report is checked against it.

import { newTransportTenant, addStaff, today, type Session } from './helpers'

const fyQuarterOf = (d: string) => {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)), fy = m >= 4 ? y : y - 1
  const qn = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4
  return `Q${qn} FY${fy}-${String(fy + 1).slice(2)}`
}

describe('CA reports', () => {
  let biz: Session, viewer: Session, manager: Session
  let cust: any
  let billA: any, billB: any, goodsBill: any, cancelled: any, receiptPayment: any, acct: any
  const rep = async (name: string, qs = '', s: Session = biz) => {
    const r = await s.api.get(`/api/transport/ca/${name}${qs}`)
    expect(r.status).toBe(200)
    return r.data
  }

  beforeAll(async () => {
    biz = await newTransportTenant('Ca Co')
    viewer = await addStaff(biz, 'viewer')
    manager = await addStaff(biz, 'manager')
    cust = (await biz.api.post('/api/parties', {
      type: 'customer', name: 'Saurastra Cement Ltd', gstin: '24ABICS4135J1Z9', pan: 'ABICS4135J', address: { city: 'Ranavav', stateCode: '24' },
    })).data

    const bill = async (tons: number, body: Record<string, unknown>, date = today(-6)) => {
      const lr = (await biz.api.post('/api/transport/lrs', {
        consignorId: cust.id, consigneeName: 'Receiver', fromCity: 'Kutch', toCity: 'Ranavav', goodsDescription: 'Flyash',
        actualWeightKg: tons * 1000, rateBasis: 'per_ton', rate: 1000, vehicleNo: 'GJ05AB1234',
      })).data
      await biz.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const r = await biz.api.post('/api/transport/bills', { partyId: cust.id, lrIds: [lr.id], date, ...body })
      expect(r.status).toBe(201)
      return r.data.invoice
    }
    billA = await bill(10, { gstMode: 'forward_18', tdsApplicable: true, tdsRatePct: 1 })     // 10,000 + 1,800 GST = 11,800; TDS 100
    billB = await bill(5, { gstMode: 'rcm' })                                                  // 5,000, no GST charged
    cancelled = await bill(2, { gstMode: 'forward_18' })                                        // 2,000 + 360 — cancelled below
    await biz.api.post(`/api/invoices/${cancelled.id}/cancel`)
    goodsBill = (await biz.api.post('/api/transport/goods-bills', {
      partyId: cust.id, date: today(-5), items: [{ description: 'Flyash', hsnSacCode: '26219000', qty: 100, unit: 'MT', rate: 350, gstRate: 5 }],
    })).data.invoice                                                                            // 35,000 + 1,750 GST = 36,750

    // the customer pays bill A net of TDS: ₹11,700 by bank + ₹100 TDS
    receiptPayment = (await biz.api.post('/api/payments', {
      partyId: cust.id, amount: 11700, method: 'bank_transfer', refNo: 'UTIBN26100612345', paymentDate: today(-3),
      allocations: [{ invoiceId: billA.id, amount: 11700 }],
    })).data
    expect((await biz.api.post(`/api/transport/bills/${billA.id}/tds`, { paymentDate: today(-3) })).status).toBe(201)

    // bank: the receipt shows on the statement and is matched to it
    acct = (await biz.api.post('/api/transport/bank/accounts', { name: 'SBI Current', openingBalance: 1000 })).data
    await biz.api.post(`/api/transport/bank/accounts/${acct.id}/import`, { rows: [
      { date: today(-3), description: 'NEFT*UTIBN26100612345*SAURASTRA', refNo: '', debit: 0, credit: 11700, balance: 12700 },
      { date: today(-2), description: 'SELF CHEQUE WITHDRAWAL', refNo: '', debit: 2000, credit: 0, balance: 10700 },
    ] })
    const lines = (await biz.api.get(`/api/transport/bank/accounts/${acct.id}/lines`)).data.data
    const credit = lines.find((l: any) => l.credit > 0)
    await biz.api.post(`/api/transport/bank/lines/${credit.id}/match`, { kind: 'link_payments', paymentIds: [receiptPayment.id] })

    // a trip: 400 km on 100 litres; ₹4,000 of diesel on account at a pump, ₹1,000 paid by the driver
    const lrForTrip = (await biz.api.post('/api/transport/lrs', { consignorName: 'Acme', consigneeName: 'Beta', fromCity: 'Surat', toCity: 'Mumbai', goodsDescription: 'Cotton', actualWeightKg: 5000, rateBasis: 'per_ton', rate: 1000 })).data
    const v = (await biz.api.post('/api/transport/vehicles', { regNo: 'GJ05CA7777', vehicleType: 'hcv', capacityTons: 25, currentOdometer: 1000 })).data
    const trip = (await biz.api.post('/api/transport/trips', { vehicleId: v.id, fromCity: 'Surat', toCity: 'Mumbai', lrIds: [lrForTrip.id], startDate: today(-4) })).data
    await biz.api.post(`/api/transport/trips/${trip.id}/start`, { startOdometer: 1000 })
    await biz.api.post('/api/transport/expenses', { tripId: trip.id, category: 'diesel', litres: 60, ratePerLitre: 66.6667, amount: 4000, paidBy: 'vendor_credit', vendorName: 'Sharma Petrol Pump', paymentMode: 'credit', expenseDate: today(-4) })
    await biz.api.post('/api/transport/expenses', { tripId: trip.id, category: 'diesel', litres: 40, amount: 1000, paidBy: 'driver', paymentMode: 'cash', expenseDate: today(-3) })
    await biz.api.post(`/api/transport/trips/${trip.id}/complete`, { endDate: today(-2), endOdometer: 1400, markLrsDelivered: true })

    // an office cost with 18% GST inside it
    await biz.api.post('/api/expenses', { category: 'rent', amount: 5900, gstRate: 18, paymentMode: 'bank', date: today(-2) })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('sales register', () => {
    test('lists freight and goods bills with GST, TDS and what is outstanding; cancelled bills are listed but not counted', async () => {
      const r = await rep('sales-register')
      expect(r.title).toBe('Sales register')
      expect(r.firm.name).toMatch(/^Ca Co/)
      const byNo = (n: string) => r.rows.find((x: any) => x['Invoice no'] === n)
      const a = byNo(billA.number), b = byNo(billB.number), g = byNo(goodsBill.number), c = byNo(cancelled.number)

      expect(a).toMatchObject({ 'Type': 'Freight bill', 'Customer': 'Saurastra Cement Ltd', 'GSTIN': '24ABICS4135J1Z9', 'PAN': 'ABICS4135J', 'Place of supply': '24',
        'GST treatment': 'Forward charge 18%', 'Taxable value': 10000, 'Invoice total': 11800, 'TDS deducted': 100, 'TDS recorded': 100, 'Received (excl. TDS)': 11700, 'Outstanding': 0 })
      expect(a['CGST'] + a['SGST']).toBeCloseTo(1800, 2)
      expect(a['LR numbers']).toMatch(/LR-/)
      expect(a['Vehicles']).toBe('')                                                  // vehicle numbers appear once the load has been on a trip

      expect(b).toMatchObject({ 'Type': 'Freight bill', 'GST treatment': 'RCM — recipient pays', 'Taxable value': 5000, 'Invoice total': 5000, 'Outstanding': 5000 })
      expect(b['CGST'] + b['SGST'] + b['IGST']).toBe(0)
      expect(g).toMatchObject({ 'Type': 'Goods bill', 'GST treatment': 'GST 5%', 'Taxable value': 35000, 'Invoice total': 36750 })
      expect(c['Status']).toBe('Cancelled')
      expect(c['Outstanding']).toBe(0)

      expect(r.totals['Taxable value']).toBe(50000)                                  // cancelled 2,000 left out
      expect(r.totals['CGST'] + r.totals['SGST'] + r.totals['IGST']).toBeCloseTo(3550, 2)
      expect(r.totals['TDS deducted']).toBe(100)
      expect(r.totals['Outstanding']).toBe(41750)                                    // 5,000 + 36,750
      expect(r.rows.map((x: any) => x['Date'])).toEqual([...r.rows.map((x: any) => x['Date'])].sort())   // oldest first
    })

    test('the period filters it, and a read-only user (the CA) can read it', async () => {
      expect((await rep('sales-register', `?from=${today(0)}&to=${today(0)}`)).rows).toEqual([])
      expect((await rep('sales-register', '', viewer)).rows.length).toBe(4)
      expect((await biz.api.get(`/api/transport/ca/sales-register?from=${today(0)}&to=${today(-9)}`)).status).toBe(422)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('receipts, expenses and fuel', () => {
    test('receipts register shows the TDS separately and whether the bank statement has each receipt', async () => {
      const r = await rep('receipts-register')
      const bank = r.rows.find((x: any) => x['Reference / UTR'] === 'UTIBN26100612345')
      expect(bank).toMatchObject({ 'Mode': 'Bank transfer', 'Amount': 11700, 'Applied to bills': billA.number, 'Not yet applied': 0, 'In bank statement': 'SBI Current', 'Status': 'Active' })
      const tds = r.rows.find((x: any) => x['Mode'] === 'TDS deducted by customer')
      expect(tds).toMatchObject({ 'Amount': 100, 'Applied to bills': billA.number })
      expect(r.totals['Received in bank / UPI / cheque']).toBe(11700)
      expect(r.totals['TDS deducted by customers']).toBe(100)
      expect(r.totals['Received in cash']).toBe(0)
    })

    test('expense register adds trip costs and office costs, with who paid and the GST inside', async () => {
      const r = await rep('expense-register')
      expect(r.totals['Trip costs']).toBe(5000)
      expect(r.totals['Office costs']).toBe(5900)
      expect(r.totals['Total expenses']).toBe(10900)
      expect(r.totals['GST paid on office costs']).toBeCloseTo(900, 1)              // 5,900 × 18 / 118
      expect(r.totals['Still owed to pumps']).toBe(4000)
      const pump = r.rows.find((x: any) => x['Vendor / pump'] === 'Sharma Petrol Pump')
      expect(pump).toMatchObject({ 'Source': 'Trip cost', 'Category': 'Diesel / Fuel', 'Paid by': 'On account at pump', 'Amount': 4000, 'Litres': 60 })
      expect(r.rows.find((x: any) => x['Source'] === 'Office cost')).toMatchObject({ 'Category': 'Office / Yard Rent', 'Paid by': 'Company', 'Mode': 'bank' })
    })

    test('fuel register totals the diesel and works out km per litre from the meter readings', async () => {
      const r = await rep('fuel-register')
      expect(r.totals).toMatchObject({ 'Litres': 100, 'Amount': 5000 })
      expect(r.rows).toHaveLength(2)
      expect(r.mileage[0]).toMatchObject({ 'Vehicle': 'GJ05CA7777', 'Km run': 400, 'Diesel (litres)': 100, 'Km per litre': 4 })
      expect(r.vehicleSummary[0]).toMatchObject({ 'Vehicle': 'GJ05CA7777', 'Trips': 1, 'Km per litre': 4 })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('screen preview', () => {
    test('?preview=N sends only the first rows but the totals still cover every row (expense register, bank book, and the ones that just trim)', async () => {
      for (const k of ['expense-register', 'bank-book', 'sales-register', 'receipts-register', 'fuel-register', 'outstanding']) {
        const full = await rep(k), pre = await rep(k, '?preview=1')
        expect(full.rows.length).toBeGreaterThan(1)
        expect(pre.rows).toHaveLength(1)
        expect(pre.truncated).toBe(true)
        expect(pre.totalRows).toBe(full.rows.length)
        expect(pre.totals).toEqual(full.totals)                                       // the same figures, whichever way they were reached
        expect(pre.rows[0]['Date']).toBe(full.rows[0]['Date'])
      }
      // the tables beside the rows are reached by a different route in a preview (aggregate queries) and must agree too
      expect((await rep('outstanding', '?preview=1')).summary).toEqual((await rep('outstanding')).summary)
      const fuel = await rep('fuel-register'), fuelPre = await rep('fuel-register', '?preview=1')
      expect(fuelPre.vehicleSummary).toEqual(fuel.vehicleSummary)
      expect(fuelPre.mileage).toEqual(fuel.mileage)
      const bank = await rep('bank-book')
      expect((await rep('bank-book', '?preview=1')).rows[0]).toEqual(bank.rows[0])
      // asking for more than there is changes nothing
      const all = await rep('expense-register', '?preview=500')
      expect(all.truncated).toBeUndefined()
      expect(all.rows).toHaveLength((await rep('expense-register')).rows.length)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('truck-wise monthly report', () => {
    test('totals the truck across the period: trips, km, freight, diesel and net profit', async () => {
      const r = await rep('truck-monthly')
      expect(r.title).toBe('Truck-wise monthly report')
      const rows = r.rows.filter((x: any) => x['Truck'] === 'GJ05CA7777')
      expect(rows.length).toBeGreaterThanOrEqual(1)                                   // two rows only if the dates straddle a month end
      expect(r.vehicleSummary).toHaveLength(1)
      expect(r.vehicleSummary[0]).toMatchObject({ 'Truck': 'GJ05CA7777', 'Month': 'Whole period', 'Trips': 1, 'Km run': 400, 'Freight': 5000, 'Diesel': 5000, 'Toll': 0, 'Total cost': 5000, 'Net profit': 0 })
      expect(r.totals).toMatchObject({ 'Trips': 1, 'Km run': 400, 'Freight': 5000, 'Diesel': 5000, 'Net profit': 0 })
    })

    test('one truck shows every month of the period, even empty ones; an unknown truck shows nothing', async () => {
      const v = (await biz.api.get('/api/transport/vehicles')).data.find((x: any) => x.regNo === 'GJ05CA7777')
      const r = await rep('truck-monthly', `?vehicleId=${v.id}&from=${today(-70)}&to=${today(0)}`)
      expect(r.rows.length).toBeGreaterThanOrEqual(3)
      expect(r.rows.every((x: any) => x['Truck'] === 'GJ05CA7777')).toBe(true)
      expect(r.totals['Freight']).toBe(5000)
      const none = await rep('truck-monthly', '?vehicleId=00000000-0000-4000-8000-000000000000')
      expect(none.rows).toEqual([])
    })

    test('weekly view: same totals, Monday-to-Sunday weeks, and one truck lists every week', async () => {
      const r = await rep('truck-weekly')
      expect(r.title).toBe('Truck-wise weekly report')
      expect(r.columns[1]).toBe('Week')
      expect(r.vehicleSummary[0]).toMatchObject({ 'Truck': 'GJ05CA7777', 'Week': 'Whole period', 'Trips': 1, 'Km run': 400, 'Freight': 5000, 'Diesel': 5000, 'Net profit': 0 })
      expect(r.rows[0]['Week']).toMatch(/^\d{1,2} [A-Z][a-z]{2} – \d{1,2} [A-Z][a-z]{2} \d{4}$/)
      const v = (await biz.api.get('/api/transport/vehicles')).data.find((x: any) => x.regNo === 'GJ05CA7777')
      const one = await rep('truck-weekly', `?vehicleId=${v.id}&from=${today(-20)}&to=${today(0)}`)
      expect(one.rows.length).toBeGreaterThanOrEqual(3)                               // 21 days touch at least 3 weeks
      expect(one.rows.length).toBeLessThanOrEqual(4)
      expect(one.totals['Freight']).toBe(5000)
    })

    test('the period filters it, and the CA (read-only) can read it', async () => {
      expect((await rep('truck-monthly', `?from=${today(1)}&to=${today(2)}`)).rows).toEqual([])
      expect((await rep('truck-monthly', '', viewer)).rows.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('TDS and GST', () => {
    test('TDS register groups by customer and quarter with PAN, and shows nothing pending once it is recorded', async () => {
      const r = await rep('tds-register')
      expect(r.rows).toHaveLength(1)
      expect(r.rows[0]).toMatchObject({ 'Customer': 'Saurastra Cement Ltd', 'PAN': 'ABICS4135J', 'Invoice no': billA.number, 'TDS rate %': 1, 'TDS deducted by customer': 100, 'TDS recorded': 100, 'Pending to record': 0 })
      expect(r.rows[0]['Quarter']).toBe(fyQuarterOf(today(-3)))                     // the quarter the TDS was recorded in
      expect(r.summary).toEqual([{ 'Quarter': fyQuarterOf(today(-3)), 'Customer': 'Saurastra Cement Ltd', 'PAN': 'ABICS4135J', 'Bills': 1, 'TDS deducted by customer': 100, 'TDS recorded': 100, 'Pending to record': 0 }])
      expect(r.totals).toEqual({ 'TDS deducted by customer': 100, 'TDS recorded': 100, 'Pending to record': 0 })
    })

    test('a bill whose TDS has not been recorded shows as pending', async () => {
      const lr = (await biz.api.post('/api/transport/lrs', { consignorId: cust.id, consigneeName: 'R', fromCity: 'A', toCity: 'B', goodsDescription: 'x', actualWeightKg: 20000, rateBasis: 'per_ton', rate: 1000 })).data
      await biz.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const b = (await biz.api.post('/api/transport/bills', { partyId: cust.id, lrIds: [lr.id], gstMode: 'rcm', tdsApplicable: true, tdsRatePct: 2, date: today(-1) })).data.invoice
      const r = await rep('tds-register')
      const row = r.rows.find((x: any) => x['Invoice no'] === b.number)
      expect(row).toMatchObject({ 'TDS deducted by customer': 400, 'TDS recorded': 0, 'Pending to record': 400, 'Recorded on': '' })
      expect(r.totals['Pending to record']).toBe(400)
      await biz.api.post(`/api/invoices/${b.id}/cancel`)                             // keep the other reports' numbers as built
      expect((await rep('tds-register')).rows).toHaveLength(1)
    })

    test('GSTR-3B summary: outward tax, RCM supplies shown separately, input credit and the indicative payable', async () => {
      const r = await rep('gstr3b')
      const row = (s: string, d: string) => r.rows.find((x: any) => x['Section'] === s && String(x['Description']).startsWith(d))
      const out = row('3.1(a)', 'Outward taxable')
      expect(out).toMatchObject({ 'Invoices': 2, 'Taxable value': 45000 })          // bill A (10,000) + goods (35,000)
      expect(out['Total tax']).toBeCloseTo(3550, 2)
      expect(row('Info', 'Freight billed with GST payable by the recipient')).toMatchObject({ 'Invoices': 1, 'Taxable value': 5000, 'Total tax': 0 })
      expect(row('3.1(c)', 'Nil-rated')['Invoices']).toBe(0)
      expect(r.totals['Outward tax (after credit notes)']).toBeCloseTo(3550, 2)
      expect(r.totals['GST on office costs (to check)']).toBeCloseTo(900, 1)
      expect(r.totals['Indicative tax payable']).toBeCloseTo(3550, 2)
      expect(r.notes.join(' ')).toMatch(/not a return/i)
      // by calendar month
      const m = await rep('gstr3b', `?month=${today(-6).slice(0, 7)}`)
      expect(m.from).toBe(`${today(-6).slice(0, 7)}-01`)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('pumps, receivables, bank and firms', () => {
    test('pump ledger: billed, paid and owed per pump; paying a bill moves it', async () => {
      const r = await rep('pump-ledger')
      expect(r.summary).toEqual([{ 'Pump': 'Sharma Petrol Pump', 'Owed at start': 0, 'Billed in period': 4000, 'Paid in period': 0, 'Owed at end': 4000 }])
      const bills = (await biz.api.get('/api/transport/expenses/payables')).data.data[0].bills
      await biz.api.post('/api/transport/expenses/settle', { ids: bills.map((b: any) => b.id), settledOn: today(-1), mode: 'upi' })
      const after = await rep('pump-ledger')
      expect(after.summary[0]).toMatchObject({ 'Billed in period': 4000, 'Paid in period': 4000, 'Owed at end': 0 })
      expect(after.rows[0]).toMatchObject({ 'Status': 'Paid', 'Paid on': today(-1) })
      expect((await rep('pump-ledger', `?to=${today(-2)}`)).summary[0]['Owed at end']).toBe(4000)       // as it stood before it was paid
    })

    test('receivables are aged by due date and grouped by customer', async () => {
      const r = await rep('outstanding')
      const nos = r.rows.map((x: any) => x['Invoice no'])
      expect(nos).toEqual(expect.arrayContaining([billB.number, goodsBill.number]))
      expect(nos).not.toContain(billA.number)                                           // fully paid
      expect(nos).not.toContain(cancelled.number)
      expect(r.totals['Total outstanding']).toBe(41750)
      expect(r.totals['Not due']).toBe(41750)                                           // 30-day credit has not run out yet
      expect(r.summary[0]).toMatchObject({ 'Customer': 'Saurastra Cement Ltd', 'Bills': 2, 'Total outstanding': 41750 })
      const later = await rep('outstanding', `?asOn=${new Date(Date.now() + 5.5 * 3600_000 + 80 * 86_400_000).toISOString().slice(0, 10)}`)
      expect(later.totals['Not due']).toBe(0)
      expect(later.totals['Total outstanding']).toBe(41750)
      expect(later.rows.every((x: any) => x['Days overdue'] > 0)).toBe(true)
    })

    test('bank book shows each statement line with what it was matched to', async () => {
      const r = await rep('bank-book')
      expect(r.rows).toHaveLength(2)
      expect(r.rows[0]).toMatchObject({ 'Bank': 'SBI Current', 'Money in': 11700, 'Status': 'Matched', 'Matched to': 'Receipt from Saurastra Cement Ltd' })
      expect(r.rows[1]).toMatchObject({ 'Money out': 2000, 'Status': 'Not matched' })
      expect(r.totals).toEqual({ 'Money in': 11700, 'Money out': 2000, 'Lines not matched': 1 })
      expect((await rep('bank-book', `?bankAccountId=${acct.id}`)).rows).toHaveLength(2)
    })

    test('combined view: owner only; every firm side by side with a total', async () => {
      expect((await manager.api.get('/api/transport/ca/combined')).status).toBe(403)
      expect((await viewer.api.get('/api/transport/ca/combined')).status).toBe(403)
      const f = await biz.api.post('/api/transport/firms', { name: 'Ca Goods Trading', kind: 'goods', stateCode: '24' })
      expect(f.status).toBe(201)
      const r = await rep('combined')
      expect(r.rows).toHaveLength(3)                                                     // two firms + the total
      const first = r.rows[0], second = r.rows[1], total = r.rows[2]
      expect(first['Firm']).toMatch(/^Ca Co/)
      expect(first).toMatchObject({ 'Sales (taxable)': 50000, 'Trip costs': 5000, 'Office costs': 5900, 'TDS deducted by customers': 100, 'Customers owe now': 41750, 'Bank lines to match': 1 })
      expect(first['Profit (sales − costs)']).toBe(39100)                                // 50,000 − 5,000 − 5,900
      expect(second).toMatchObject({ 'Firm': 'Ca Goods Trading', 'Sales (taxable)': 0, 'Bills': 0 })
      expect(total).toMatchObject({ 'Firm': 'All firms together', 'Sales (taxable)': 50000, 'Profit (sales − costs)': 39100 })
    })
  })
})
