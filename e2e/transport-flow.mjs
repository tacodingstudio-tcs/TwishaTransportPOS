// Interactive end-to-end test of the transport UI in real Chrome (uses the puppeteer already
// installed in apps/api for PDF rendering).
//
//   1. start the stack:  docker compose -f docker/docker-compose.yml up -d postgres redis
//                        pnpm --filter @billing/api dev      (port 3100)
//                        pnpm --filter @billing/web dev      (port 5174)
//   2. seed the demo:    pnpm seed
//   3. run:              pnpm e2e
//
// Env: WEB_URL (default http://localhost:5174), CHROME_PATH (default: system Chrome).
// Walks: book LR → plan/start/expense/complete trip → record POD → raise freight bill.
// Screenshots are written to e2e/out/.
import { createRequire } from 'module'
import fs from 'fs'
import { fileURLToPath } from 'url'

const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const puppeteer = require('puppeteer')

const BASE = process.env.WEB_URL ?? 'http://localhost:5174'
const OUT = process.argv[2] ?? fileURLToPath(new URL('./out', import.meta.url))
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? ({
    win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })[process.platform] ?? '/usr/bin/google-chrome',
  headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 1000 },
})
const page = await browser.newPage()
const apiErrors = []
page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) apiErrors.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`) })
page.on('pageerror', (e) => apiErrors.push(`pageerror ${e}`))
page.on('dialog', (d) => d.accept())

let step = 0
async function shot(name) { await page.screenshot({ path: `${OUT}/${String(++step).padStart(2, '0')}-${name}.png` }) }
function fail(msg) { throw new Error(msg) }
async function expectText(text, timeout = 8000) {
  try { await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text) }
  catch { await shot('FAIL'); fail(`expected page text "${text}" — url ${page.url()}`) }
}
const xp = (x) => page.waitForSelector(`xpath/${x}`, { timeout: 8000 })
const byLabel = (label, tag = 'input') => xp(`//label[normalize-space(.)="${label}" or starts-with(normalize-space(.),"${label}")]/following-sibling::${tag}[1]`)
async function typeInto(handle, text) { await handle.click({ clickCount: 3 }); await handle.type(text) }
async function clickBtn(text) { const b = await xp(`//button[contains(normalize-space(.),"${text}")]`); await b.click() }

try {
  // login
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' })
  await page.type('input[type="tel"]', '9100000001'); await page.type('input[type="password"]', '1111')
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')])

  // ── A. book an LR ─────────────────────────────────────────────────────────
  await page.goto(`${BASE}/transport/lrs/new`, { waitUntil: 'networkidle0' })
  const partyInputs = await page.$$('input[placeholder="Type name to search, or write a new name"]')
  await partyInputs[0].type('Arvind')
  const sug = await xp('//button[.//div[contains(.,"Arvind Textiles")]]'); await sug.click()
  await partyInputs[1].type('Walk-in Receiver Traders')   // free-typed, not a saved party
  const cities = await page.$$('input[list]')
  await cities[0].type('Surat'); await cities[1].type('Mumbai')
  await page.type('input[placeholder^="e.g. Fly ash"]', 'Cotton yarn cones, 120 bags')
  await typeInto(await byLabel('Quantity loaded (MT)'), '12')
  await typeInto(await byLabel('Value of goods (₹)'), '250000')
  // rate card should be offered for Surat → Mumbai
  await expectText('Your usual rate:')
  await clickBtn('Apply')
  await sleep(300)
  await expectText('₹13,800.00')                          // 12 t × ₹1,150
  await shot('lr-form-filled')
  await clickBtn('Save load')
  await page.waitForFunction(() => /\/transport\/lrs\/[0-9a-f-]{36}$/.test(location.pathname), { timeout: 8000 })
  await expectText('Booked')
  await expectText('Walk-in Receiver Traders')
  const lrNo = (await page.$eval('h1', (h) => h.textContent)).trim()
  console.log('A ✓ booked', lrNo)
  await shot('lr-booked')

  // ── B. plan a trip with that LR, start, expense, complete ──────────────────
  await page.goto(`${BASE}/transport/trips`, { waitUntil: 'networkidle0' })
  await clickBtn('New trip')
  await expectText('New truck trip')
  const vehicleSel = await byLabel('Truck *', 'select')
  await page.waitForFunction(() => (document.querySelector('.fixed select')?.options.length ?? 0) > 1, { timeout: 8000 })   // truck list loaded
  // pick any AVAILABLE vehicle with ≥ 12 t capacity and any available driver (keeps the run repeatable)
  const opt = await page.$$eval('.fixed select option', (os) =>
    os.find((o) => / available$/.test(o.textContent.trim()) && Number(/ (\d+(?:\.\d+)?)T /.exec(o.textContent)?.[1] ?? 0) >= 12)?.value)
  if (!opt) fail('no available vehicle with 12t+ capacity — is a previous run stuck on the road?')
  await vehicleSel.select(opt)
  const driverSel = await byLabel('Driver', 'select')
  const dopt = await page.$$eval('.fixed select option', (os) => os.find((o) => /· available$/.test(o.textContent.trim()) && o.value)?.value)
  if (!dopt) fail('no available driver')
  await driverSel.select(dopt)
  const tripCities = await page.$$('.fixed input[list]')
  await tripCities[0].type('Surat'); await tripCities[1].type('Mumbai')
  await typeInto(await byLabel('Driver advance (₹)'), '6000')
  const lrBox = await xp(`//label[.//span[contains(.,"${lrNo}")]]//input[@type="checkbox"]`); await lrBox.click()
  await shot('trip-modal')
  await clickBtn('Save trip')
  await page.waitForFunction(() => /\/transport\/trips\/[0-9a-f-]{36}$/.test(location.pathname), { timeout: 8000 })
  await expectText('Not started')
  console.log('B1 ✓ trip planned')

  await clickBtn('Start trip'); await expectText('Truck meter reading now'); await (await xp('//button[normalize-space(.)="Start"]')).click()
  await expectText('On the way'); console.log('B2 ✓ trip started')

  await clickBtn('Add cost'); await expectText('Add diesel / trip cost')
  await typeInto(await byLabel('Litres'), '150'); await typeInto(await byLabel('Rate / litre (₹)'), '90')
  await expectText('₹13,500.00 from litres')
  await clickBtn('Save')
  await page.waitForFunction(() => !document.body.innerText.includes('Add diesel / trip cost'), { timeout: 8000 })   // modal closed
  await expectText('150.0 L'); console.log('B3 ✓ diesel expense (150 L × ₹90 = ₹13,500)')

  await clickBtn('Finish trip'); await expectText('Finish trip')
  await expectText('All 1 load is delivered')
  const markAll = await xp('//label[contains(.,"All 1 load is delivered")]//input'); await markAll.click()
  // arrival odometer must be ≥ departure; the dialog shows "≥ <start>" as its placeholder
  const odoField = await byLabel('Truck meter reading at end (km)')
  const startOdo = Number(((await odoField.evaluate((el) => el.placeholder)) || '').replace(/\D/g, '')) || 0
  await typeInto(odoField, String(startOdo + 560))
  await shot('trip-complete-dialog')
  const completeBtns = await page.$$('xpath///button[normalize-space(.)="Finish"]'); await completeBtns[0].click()
  await expectText('Finished'); console.log('B4 ✓ trip completed, LR auto-delivered')
  await expectText('₹13,800'); await shot('trip-completed')

  // ── C. LR → POD, then bill it ──────────────────────────────────────────────
  await page.goto(`${BASE}/transport/lrs?q=${encodeURIComponent('Walk-in Receiver')}`, { waitUntil: 'networkidle0' })
  await expectText('Delivered')
  const row = await xp(`//tr[.//td[contains(.,"${lrNo}")]]`); await row.click()
  await expectText('Signed copy received'); await clickBtn('Signed copy received'); await expectText('Signed copy received')
  await clickBtn('Save'); await expectText('Signed copy back'); console.log('C1 ✓ POD recorded')

  await page.goto(`${BASE}/transport/billing`, { waitUntil: 'networkidle0' })
  const cust = await xp('//button[.//span[contains(.,"Arvind Textiles")]]'); await cust.click()
  await expectText('Loads without a bill')
  const rowCheck = await xp(`//tr[.//td[contains(.,"${lrNo}")]]`); await rowCheck.click()
  const sel = await byLabel('How is GST charged?', 'select'); await sel.select('forward_5')
  await expectText('GST @ 5%')
  await expectText('₹14,490.00')                         // 13,800 + 5% = 14,490
  await shot('billing-selected')
  await clickBtn('Make bill')
  await page.waitForFunction(() => /\/invoices\/[0-9a-f-]{36}$/.test(location.pathname), { timeout: 10000 })
  await expectText('14,490'); console.log('C2 ✓ freight bill created: ₹14,490 incl. 5% GST')
  await shot('invoice')

  // ── D. a read-only staff member signs in with the business phone and cannot act ──
  await page.evaluate(() => localStorage.clear())
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' })
  await clickBtn('Staff member')
  await page.waitForFunction(() => document.querySelectorAll('input[type="tel"]').length === 2, { timeout: 5000 })
  const phones = await page.$$('input[type="tel"]')
  await phones[0].type('9100000012')          // viewer's own phone
  await phones[1].type('9100000001')          // business (owner) phone
  await page.type('input[type="password"]', '3333')
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')])
  await expectText('Home')
  if ((await page.$$('xpath///a[contains(.,"New Load")]')).length) fail('viewer should not see the New LR button')
  await page.goto(`${BASE}/transport/lrs?status=booked,in_transit`, { waitUntil: 'networkidle0' })
  const first = await xp('//tbody/tr'); await first.click()
  await expectText('Where is this load?')
  const text = await page.evaluate(() => document.body.innerText)
  if (/Mark delivered|Cancel LR|Assign to trip/.test(text)) fail('viewer sees lifecycle actions')
  console.log('D ✓ staff sign-in works; viewer has no write actions')

  // ── E. a month of trips pasted from Excel → bill with GST + TDS → printable statement ──
  // Mirrors a real transporter's GTA bill: 14 trips, ₹4,48,239.48 freight, 18% GST, 1% TDS.
  await page.evaluate(() => localStorage.clear())
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' })
  await page.type('input[type="tel"]', '9100000001'); await page.type('input[type="password"]', '1111')
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')])

  const run = String(Date.now()).slice(-6)
  const customerName = `Saurastra Cement ${run}`
  await page.evaluate(async (name) => {
    let token = null
    for (const k of Object.keys(localStorage)) { try { token = JSON.parse(localStorage.getItem(k))?.state?.accessToken ?? token } catch {} }
    await fetch('/api/parties', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ type: 'customer', name, address: { city: 'Ranavav', stateCode: '24' } }) })
  }, customerName)

  const TRIPS = [
    ['14-08-2026', 'GJ10TX6971', 3464, '3004343531', 'PALITANA', 29.48, 29.45, 890],
    ['18-08-2026', 'GJ10TX6971', 3473, '3004344330', 'LATHIDAD BOTAD', 29.68, 29.79, 1043],
    ['29-08-2026', 'GJ18BT2626', 3495, '3004346534', 'ANKLAV', 34.37, 34.48, 1421],
    ['29-08-2026', 'GJ10TX6971', 3496, '3004346555', 'SUTRAPADA', 29.59, 29.50, 163],
    ['31-08-2026', 'GJ32V5599', 3499, '3004346952', 'ADALAJ GANDHINAG', 34.46, 34.35, 1300],
    ['01-09-2026', 'GJ32V4774', 3500, '3004347036', 'SIHOR BHAVNAGAR', 34.31, 34.15, 949],
    ['03-09-2026', 'GJ32V4774', 3504, '3004347323', 'ANAND', 34.06, 33.99, 1404],
    ['05-09-2026', 'GJ18BT2626', 3505, '3004347447', 'BOTAD', 34.18, 34.00, 1043],
    ['05-09-2026', 'GJ32V5599', 3506, '3004347445', 'BHAVNAGAR', 33.97, 33.99, 969],
    ['06-09-2026', 'GJ32V4774', 3507, '3004347617', 'BHAVNAGAR', 34.52, 34.69, 969],
    ['08-09-2026', 'GJ32V5599', 3511, '3004347959', 'BOTAD', 34.21, 34.12, 1043],
    ['08-09-2026', 'GJ10TX6971', 3512, '3004348056', 'RAJULA', 29.59, 29.59, 550],
    ['09-09-2026', 'GJ18BT2626', 3515, '3004348203', 'PALITANA', 34.07, 34.07, 890],
    ['09-09-2026', 'GJ32V4774', 3516, '3004348224', 'LATHI AMRELI', 34.33, 34.27, 813],
  ]
  // columns as in the operator's sheet: Date, Truck, LR no, Gate pass, Destination, Shipment no, Load, Unload, Rate
  const tsv = TRIPS.map(([d, t, lr, gp, dest, load, unload, rate]) => [d, t, 'R' + run + '-' + lr, gp, dest, '', load, unload, rate].join('\t')).join('\n')

  await page.goto(`${BASE}/transport/lrs/quick`, { waitUntil: 'networkidle0' })
  const picker = await page.waitForSelector('input[placeholder="Type name to search, or write a new name"]')
  await picker.type('Saurastra Cement ' + run)
  const suggestion = await xp(`//button[.//div[contains(.,"${customerName}")]]`); await suggestion.click()
  await (await page.$('.card input[list]')).type('Kodinar')
  await page.type('input[placeholder="Fly ash"]', 'Fly ash')
  await page.evaluate((text) => {
    const el = document.querySelector('input[aria-label="Date row 1"]')
    const dt = new DataTransfer(); dt.setData('text', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, tsv)
  await expectText('Pasted 14 rows')
  await expectText('₹4,48,239.48')                      // grid total = sum of rate × load qty per row
  await shot('quick-entry-pasted')
  await clickBtn('Save 14 loads')
  await page.waitForFunction(() => location.pathname === '/transport/billing', { timeout: 15000 })
  await expectText('Loads without a bill (14)')
  console.log('E1 ✓ 14 trips pasted from Excel and booked as delivered')

  await clickBtn('Select all')
  await (await byLabel('How is GST charged?', 'select')).select('forward_18')
  await (await xp('//label[contains(.,"Party will keep TDS")]//input')).click()
  await expectText('Less TDS (tax kept) @ 1%')
  await expectText('₹5,24,441.00')                      // net receivable after 1% TDS
  await shot('billing-tds')
  await clickBtn('Make bill')
  await page.waitForFunction(() => /\/invoices\/[0-9a-f-]{36}$/.test(location.pathname), { timeout: 15000 })
  const invoiceId = page.url().split('/').pop()
  console.log('E2 ✓ freight bill created')

  // customer paid the net amount: record the TDS they kept back so the bill's outstanding is the net figure
  await expectText('TDS (tax) kept by party: ₹4,482.00')
  await clickBtn('Note TDS'); await expectText('Note TDS kept by party')
  await (await xp('//button[normalize-space(.)="Save"]')).click()
  await expectText('All noted')
  await expectText('₹5,24,441.00')
  await shot('invoice-tds-recorded')
  console.log('E2b ✓ TDS recorded — outstanding is now the net ₹5,24,441')

  await page.goto(`${BASE}/transport/bills/${invoiceId}/print`, { waitUntil: 'networkidle0' })
  await expectText('LATHI AMRELI'); await expectText('Net receivable'); await expectText('₹5,24,441.00')
  await expectText('Five Lakh Twenty Eight Thousand Nine Hundred Twenty Three Only')
  await shot('freight-statement')
  console.log('E3 ✓ printable freight statement: 14 trips, GST, TDS, net receivable, amount in words')
} catch (e) {
  console.error('E2E FAILED:', e.message)
  process.exitCode = 1
} finally {
  console.log('API errors seen:', apiErrors.length ? '\n  ' + [...new Set(apiErrors)].join('\n  ') : 'none')
  await browser.close()
}
