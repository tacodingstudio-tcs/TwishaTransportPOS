// apps/api/src/services/gstin.service.ts
// GSTIN lookup via GSTZen API (gstzen.in).
// Sign up at https://www.gstzen.in to get a free API token.
// Set GSTZEN_API_KEY in apps/api/.env.

const API_KEY  = process.env['GSTZEN_API_KEY'] ?? ''
const BASE_URL = 'https://www.gstzen.in/a/fetch-gstin-details.html'

// GSTIN format: 2-digit state code + 10-char PAN + entity no + 'Z' + checksum
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export interface GSTINDetails {
  gstin:                  string
  legalName:              string
  tradeName:              string | null
  status:                 'ACTIVE' | 'CANCELLED' | 'SUSPENDED' | string
  taxPayerType:           string
  constitutionOfBusiness: string
  stateCode:              string
  stateName:              string | null
  registrationDate:       string | null
  address:                string | null
}

export async function lookupGSTIN(gstin: string): Promise<GSTINDetails> {
  const normalized = gstin.trim().toUpperCase()

  if (!GSTIN_REGEX.test(normalized)) {
    throw Object.assign(
      new Error(`Invalid GSTIN format: ${gstin}`),
      { statusCode: 422, code: 'INVALID_GSTIN' }
    )
  }

  if (!API_KEY) {
    throw Object.assign(
      new Error('GSTIN lookup is not configured — set GSTZEN_API_KEY in .env (get a free key at gstzen.in)'),
      { statusCode: 503, code: 'GSTIN_NOT_CONFIGURED' }
    )
  }

  let raw: Record<string, unknown>
  try {
    // GSTZen accepts gstin + token as query params (GET)
    const url = `${BASE_URL}?t=${normalized}&token=${API_KEY}`
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      throw Object.assign(
        new Error(`GSTZen returned ${res.status}`),
        { statusCode: 502, code: 'GSTIN_API_ERROR' }
      )
    }

    raw = await res.json() as Record<string, unknown>
  } catch (err: unknown) {
    const e = err as { statusCode?: number }
    if (e.statusCode) throw err
    throw Object.assign(
      new Error('Could not reach GST lookup service — try again'),
      { statusCode: 502, code: 'GSTIN_API_UNREACHABLE' }
    )
  }

  // GSTZen returns { status_cd: "1", data: {...} } on success
  // or { status_cd: "0", message: "..." } on not found
  const statusCd = raw['status_cd'] ?? raw['statuscd']
  if (statusCd === '0' || statusCd === 0) {
    throw Object.assign(
      new Error(`GSTIN ${normalized} not found in GST portal`),
      { statusCode: 404, code: 'GSTIN_NOT_FOUND' }
    )
  }

  const d = (raw['data'] ?? raw) as Record<string, unknown>

  return {
    gstin:                  normalized,
    legalName:              String(d['lgnm'] ?? d['legalName'] ?? ''),
    tradeName:              d['tradeNam'] ? String(d['tradeNam']) : null,
    status:                 normalizeStatus(String(d['sts'] ?? d['status'] ?? 'UNKNOWN')),
    taxPayerType:           String(d['dty'] ?? d['taxPayerType'] ?? ''),
    constitutionOfBusiness: String(d['ctb'] ?? d['constitutionOfBusiness'] ?? ''),
    stateCode:              normalized.slice(0, 2),
    stateName:              stateFromCode(normalized.slice(0, 2)),
    registrationDate:       d['rgdt'] ? String(d['rgdt']) : null,
    address:                extractAddress(d),
  }
}

function normalizeStatus(raw: string): GSTINDetails['status'] {
  const u = raw.toUpperCase()
  if (u === 'ACT' || u === 'ACTIVE')     return 'ACTIVE'
  if (u === 'CNL' || u === 'CANCELLED')  return 'CANCELLED'
  if (u === 'SUS' || u === 'SUSPENDED')  return 'SUSPENDED'
  return raw
}

function extractAddress(d: Record<string, unknown>): string | null {
  // GSTZen principal address: d.pradr.adr (full address string)
  const pradr = d['pradr'] as Record<string, unknown> | undefined
  if (pradr?.['adr']) return String(pradr['adr'])

  // Fallback: build from sub-fields
  if (pradr?.['addr']) {
    const a = pradr['addr'] as Record<string, unknown>
    const parts = [a['bno'], a['bnm'], a['flno'], a['st'], a['locality'],
                   a['loc'], a['dst'], a['stcd'], a['pncd']].filter(Boolean)
    return parts.length > 0 ? parts.join(', ') : null
  }
  return null
}

const STATE_CODES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh',      '05': 'Uttarakhand',      '06': 'Haryana',
  '07': 'Delhi',           '08': 'Rajasthan',         '09': 'Uttar Pradesh',
  '10': 'Bihar',           '11': 'Sikkim',            '12': 'Arunachal Pradesh',
  '13': 'Nagaland',        '14': 'Manipur',           '15': 'Mizoram',
  '16': 'Tripura',         '17': 'Meghalaya',         '18': 'Assam',
  '19': 'West Bengal',     '20': 'Jharkhand',         '21': 'Odisha',
  '22': 'Chhattisgarh',    '23': 'Madhya Pradesh',    '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',     '28': 'Andhra Pradesh',    '29': 'Karnataka',
  '30': 'Goa',             '31': 'Lakshadweep',       '32': 'Kerala',
  '33': 'Tamil Nadu',      '34': 'Puducherry',        '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',       '37': 'Andhra Pradesh',    '38': 'Ladakh',
}

function stateFromCode(code: string): string | null {
  return STATE_CODES[code] ?? null
}
