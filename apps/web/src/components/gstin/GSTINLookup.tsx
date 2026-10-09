// GSTIN lookup widget — validates format + queries GST portal
import { useState } from 'react'
import { Search, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { useGstinLookup } from '@/hooks/useApi'

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export function GSTINLookup() {
  const [input, setInput] = useState('')
  const [gstin, setGstin] = useState('')

  const { data, isLoading, isError, error } = useGstinLookup(gstin)

  function handleSearch() {
    const v = input.trim().toUpperCase()
    if (v.length === 15 && GSTIN_REGEX.test(v)) {
      setGstin(v)
    }
  }

  const formatValid = input.length === 0 || (input.length === 15 && GSTIN_REGEX.test(input.toUpperCase()))

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-4">GST Portal Lookup</h2>

      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Enter GSTIN (e.g. 27AADCS0472N1Z1)"
          maxLength={15}
          className={`flex-1 text-sm border rounded-lg px-3 py-2 font-mono tracking-wide focus:outline-none focus:ring-2 ${
            formatValid
              ? 'border-gray-300 focus:ring-primary-500'
              : 'border-red-300 focus:ring-red-400'
          }`}
        />
        <button
          onClick={handleSearch}
          disabled={input.length !== 15 || !formatValid || isLoading}
          className="btn-primary flex items-center gap-1.5 px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          Search
        </button>
      </div>

      {!formatValid && (
        <p className="text-xs text-red-500 mb-3">Invalid GSTIN format — must be 15 characters</p>
      )}

      {isError && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">
          <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{(error as any)?.response?.data?.error ?? 'Could not fetch GSTIN details'}</span>
        </div>
      )}

      {data && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 mb-1">
            {data.status === 'ACTIVE' ? (
              <CheckCircle className="w-4 h-4 text-primary-600" />
            ) : (
              <XCircle className="w-4 h-4 text-red-500" />
            )}
            <span className={`text-xs font-semibold uppercase tracking-wide ${
              data.status === 'ACTIVE' ? 'text-primary-700' : 'text-red-600'
            }`}>
              {data.status}
            </span>
          </div>

          <div>
            <div className="text-base font-bold text-gray-900">{data.legalName}</div>
            {data.tradeName && data.tradeName !== data.legalName && (
              <div className="text-sm text-gray-500">Trade name: {data.tradeName}</div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs mt-2">
            <Row label="GSTIN"     value={data.gstin} mono />
            <Row label="State"     value={data.stateName ?? data.stateCode} />
            <Row label="Type"      value={data.taxPayerType} />
            <Row label="Entity"    value={data.constitutionOfBusiness} />
            {data.registrationDate && (
              <Row label="Registered" value={data.registrationDate} />
            )}
          </div>

          {data.address && (
            <div className="text-xs text-gray-500 mt-1 border-t border-gray-100 pt-2">
              {data.address}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <span className="text-gray-400">{label}</span>
      <span className={`text-gray-700 font-medium truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
    </>
  )
}
