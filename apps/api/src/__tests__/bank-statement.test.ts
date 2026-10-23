// Bank statement reader (packages/shared/src/bank-statement.ts) — pure functions, no API needed.
// Layouts below copy how the four common banks word their net-banking downloads.

import {
  parseBankStatementRows, parseBankDate, parseBankAmount, extractBankRef, bankMethodFromNarration, nameHits, nameTokens,
} from '../../../../packages/shared/src/bank-statement'

describe('bank statement reader', () => {
  describe('dates and amounts', () => {
    test('dates as banks write them', () => {
      expect(parseBankDate('05/10/2026')).toBe('2026-10-05')
      expect(parseBankDate('05-10-26')).toBe('2026-10-05')
      expect(parseBankDate('5 Oct 2026')).toBe('2026-10-05')
      expect(parseBankDate('05-Oct-2026')).toBe('2026-10-05')
      expect(parseBankDate('2026-10-05')).toBe('2026-10-05')
      expect(parseBankDate('05.10.2026')).toBe('2026-10-05')
      expect(parseBankDate(46300)).toBe('2026-10-05')                       // Excel serial day
      expect(parseBankDate('31/02/2026')).toBeNull()                         // not a real day
      expect(parseBankDate('Opening Balance')).toBeNull()
      expect(parseBankDate('')).toBeNull()
    })

    test('amounts with commas, symbols, brackets and Dr/Cr suffixes', () => {
      expect(parseBankAmount('1,23,456.78')).toBe(123456.78)
      expect(parseBankAmount('₹ 500')).toBe(500)
      expect(parseBankAmount('(250.00)')).toBe(-250)
      expect(parseBankAmount('1,000.00 Cr')).toBe(1000)
      expect(parseBankAmount('1,000.00 Dr')).toBe(-1000)
      expect(parseBankAmount(12.5)).toBe(12.5)
      expect(parseBankAmount('')).toBeNull()
      expect(parseBankAmount('abc')).toBeNull()
    })
  })

  describe('layouts', () => {
    const sbi = [
      ['Account Name :', 'RAJHANSH ROADWAYS', '', '', '', '', ''],
      ['Account Number :', '66005054020', '', '', '', '', ''],
      ['Statement From :', '01-10-2026 to 31-10-2026', '', '', '', '', ''],
      [],
      ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
      ['05 Oct 2026', '05 Oct 2026', 'TO TRANSFER-UPI/DR/628812345678/SHARMA PET/SBIN/sharma@sbi', 'TRANSFER TO 4897', '14,200.00', '', '3,45,800.00'],
      ['06 Oct 2026', '06 Oct 2026', 'BY TRANSFER-NEFT*UTIBN26100612345*SAURASTRA CEMENT LTD', 'NEFT', '', '5,35,072.00', '8,80,872.00'],
      ['Total', '', '', '', '14,200.00', '5,35,072.00', ''],
    ]

    test('SBI: skips the account-details block, reads debit / credit / balance, ignores the totals row', () => {
      const r = parseBankStatementRows(sbi)
      expect(r.headerRow).toBe(4)
      expect(r.rows).toHaveLength(2)
      expect(r.rows[0]).toMatchObject({ date: '2026-10-05', debit: 14200, credit: 0, balance: 345800, refNo: 'TRANSFER TO 4897' })
      expect(r.rows[1]).toMatchObject({ date: '2026-10-06', debit: 0, credit: 535072, balance: 880872 })
      expect(r.fromDate).toBe('2026-10-05'); expect(r.toDate).toBe('2026-10-06')
      expect(r.closingBalance).toBe(880872)
      expect(r.openingBalance).toBe(360000)                                  // 3,45,800 + 14,200
      expect(r.warnings).toEqual([])
    })

    test('Axis: DR / CR columns, dd-mm-yyyy dates, CHQNO', () => {
      const r = parseBankStatementRows([
        ['SRL NO', 'Tran Date', 'CHQNO', 'PARTICULARS', 'DR', 'CR', 'BAL', 'SOL'],
        [1, '05-10-2026', '', 'UPI/P2A/628812345678/SHARMA PETROL PUMP', 14200, '', 345800, '1234'],
        [2, '06-10-2026', '000123', 'RTGS-UTIBH26100600001-SAURASTRA CEMENT', '', 535072, 880872, '1234'],
      ])
      expect(r.rows.map((x) => [x.date, x.debit, x.credit, x.refNo])).toEqual([['2026-10-05', 14200, 0, ''], ['2026-10-06', 0, 535072, '000123']])
      expect(r.columns.debit).toBe(4); expect(r.columns.credit).toBe(5); expect(r.columns.balance).toBe(6)
    })

    test('HDFC: Narration, Chq./Ref.No., Withdrawal Amt., Deposit Amt., Closing Balance, dd/mm/yy', () => {
      const r = parseBankStatementRows([
        ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
        ['05/10/26', 'NEFT DR-SBIN0001234-JAY AMBE FUEL', '0000123456789', '05/10/26', '3792.60', '', '100000.00'],
        ['07/10/26', 'IMPS-628812345678-ARVIND TEXTILES', '628812345678', '07/10/26', '', '50000.00', '150000.00'],
      ])
      expect(r.rows).toHaveLength(2)
      expect(r.rows[0]).toMatchObject({ date: '2026-10-05', debit: 3792.6, refNo: '0000123456789' })
      expect(r.rows[1]).toMatchObject({ date: '2026-10-07', credit: 50000, balance: 150000 })
    })

    test('ICICI: picks the transaction date (not the value date) and the "(INR)" amount columns', () => {
      const r = parseBankStatementRows([
        ['S No.', 'Value Date', 'Transaction Date', 'Cheque Number', 'Transaction Remarks', 'Withdrawal Amount (INR)', 'Deposit Amount (INR)', 'Balance (INR)'],
        [1, '06/10/2026', '05/10/2026', '-', 'UPI/628812345678/Diesel', '2,000.00', '0.00', '98,000.00'],
      ])
      expect(r.columns.date).toBe(2)
      expect(r.rows[0]).toMatchObject({ date: '2026-10-05', debit: 2000, credit: 0, balance: 98000 })
    })

    test('one amount column plus a Dr/Cr marker', () => {
      const r = parseBankStatementRows([
        ['Date', 'Narration', 'Amount', 'Dr/Cr', 'Balance'],
        ['05/10/2026', 'Diesel', '2,000.00', 'DR', '98,000.00'],
        ['06/10/2026', 'Freight received', '5,000.00', 'CR', '1,03,000.00'],
      ])
      expect(r.rows.map((x) => [x.debit, x.credit])).toEqual([[2000, 0], [0, 5000]])
    })
  })

  describe('awkward files', () => {
    test('newest-first statements come back oldest-first', () => {
      const r = parseBankStatementRows([
        ['Date', 'Narration', 'Debit', 'Credit', 'Balance'],
        ['07/10/2026', 'later', '', '300', '800'],
        ['06/10/2026', 'earlier', '100', '', '500'],
      ])
      expect(r.rows.map((x) => x.description)).toEqual(['earlier', 'later'])
      expect(r.closingBalance).toBe(800)
      expect(r.warnings).toEqual([])
    })

    test('Excel date numbers work, and a declared opening-balance row is used', () => {
      const r = parseBankStatementRows([
        ['Date', 'Narration', 'Debit', 'Credit', 'Balance'],
        ['', 'Opening Balance', '', '', '1,000.00'],
        [46300, 'Freight', '', 500, 1500],
      ])
      expect(r.rows).toHaveLength(1)
      expect(r.rows[0]!.date).toBe('2026-10-05')
      expect(r.openingBalance).toBe(1000)
    })

    test('a line with money both out and in is left out and reported; balance-only lines are ignored', () => {
      const r = parseBankStatementRows([
        ['Date', 'Narration', 'Debit', 'Credit', 'Balance'],
        ['05/10/2026', 'good', '100', '', '900'],
        ['05/10/2026', 'odd', '50', '60', '910'],
        ['05/10/2026', 'balance only', '', '', '910'],
      ])
      expect(r.rows).toHaveLength(1)
      expect(r.skipped).toBe(1)
      expect(r.warnings.join(' ')).toMatch(/skipped|left out/i)
    })

    test('running balances that do not follow are flagged (file incomplete)', () => {
      const r = parseBankStatementRows([
        ['Date', 'Narration', 'Debit', 'Credit', 'Balance'],
        ['05/10/2026', 'a', '100', '', '900'],
        ['06/10/2026', 'b', '100', '', '500'],     // should be 800
      ])
      expect(r.warnings.join(' ')).toMatch(/running balance/i)
    })

    test('a file that is not a statement gives a clear message instead of rows', () => {
      const r = parseBankStatementRows([['Name', 'Phone'], ['A', '1']])
      expect(r.rows).toEqual([])
      expect(r.warnings[0]).toMatch(/Could not find the table/i)
    })

    test('the user can correct the column mapping', () => {
      const aoa = [['When', 'What', 'Out', 'In'], ['05/10/2026', 'x', '10', ''], ['06/10/2026', 'y', '', '20']]
      expect(parseBankStatementRows(aoa).rows).toEqual([])                     // unknown wording → nothing guessed
      const r = parseBankStatementRows(aoa, { headerRow: 0, columns: { date: 0, description: 1, debit: 2, credit: 3 } })
      expect(r.rows.map((x) => [x.date, x.debit, x.credit])).toEqual([['2026-10-05', 10, 0], ['2026-10-06', 0, 20]])
    })
  })

  describe('reading references and names out of narrations', () => {
    test('UTR / UPI / cheque references', () => {
      expect(extractBankRef('NEFT*UTIBN26100612345*SAURASTRA CEMENT')).toBe('UTIBN26100612345')
      expect(extractBankRef('UPI/DR/628812345678/SHARMA PET')).toBe('628812345678')
      expect(extractBankRef('IMPS-628812345678-ARVIND')).toBe('628812345678')
      expect(extractBankRef('CHQ NO 000123 CLEARING')).toBe('000123')
      expect(extractBankRef('INTEREST CREDIT')).toBe('')
    })

    test('how the money moved', () => {
      expect(bankMethodFromNarration('UPI/CR/628812345678/X')).toBe('upi')
      expect(bankMethodFromNarration('CHQ DEP - CLG 000123')).toBe('cheque')
      expect(bankMethodFromNarration('NEFT*UTIB*X')).toBe('bank_transfer')
    })

    test('customer and pump names are recognised by their distinctive words only', () => {
      expect(nameTokens('Saurastra Cement Limited')).toEqual(['saurastra'])
      expect(nameHits('Saurastra Cement Limited', 'NEFT*UTIBN26100612345*SAURASTRA CEMENT LTD')).toBe(1)
      expect(nameHits('Sharma Petrol Pump', 'UPI/DR/628812345678/SHARMA PET/SBIN')).toBe(1)
      expect(nameHits('Patel Fuel Station', 'NEFT SHARMA PETROL')).toBe(0)
    })
  })
})
