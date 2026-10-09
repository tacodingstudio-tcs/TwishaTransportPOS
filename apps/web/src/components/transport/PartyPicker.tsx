import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { partyApi } from '@/lib/api'
import { Search, X, Building2 } from 'lucide-react'

export interface PickedParty {
  id?:      string
  name:     string
  gstin?:   string | null
  phone?:   string | null
  address?: any
}

interface PartyPickerProps {
  label:     string
  value:     PickedParty
  onChange:  (p: PickedParty) => void
  required?: boolean
}

/**
 * Consignor / consignee picker. Picks a saved party (id + GSTIN + address are
 * carried over) or accepts a free-typed name for one-off consignments.
 */
export function PartyPicker({ label, value, onChange, required }: PartyPickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data } = useQuery({
    queryKey: ['transport-party-search', value.name],
    queryFn:  () => partyApi.list({ search: value.name, limit: 8 }),
    enabled:  open && !value.id && value.name.trim().length >= 2,
  })
  const results: any[] = data?.data ?? []

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  return (
    <div ref={ref} className="relative">
      <label className="label">{label}{required && ' *'}</label>
      {value.id ? (
        <div className="flex items-center justify-between px-3 py-2 bg-primary-50 border border-primary-200 rounded-lg">
          <div className="flex items-center gap-2 min-w-0">
            <Building2 className="w-4 h-4 text-primary-600 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{value.name}</div>
              <div className="text-xs text-gray-500 truncate">
                {[value.gstin, value.phone].filter(Boolean).join(' · ') || 'Saved party'}
              </div>
            </div>
          </div>
          <button type="button" title="Clear" onClick={() => onChange({ name: '' })}
            className="p-1 hover:bg-primary-100 rounded-md">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9" placeholder="Type name to search, or write a new name"
              value={value.name}
              onChange={(e) => { onChange({ name: e.target.value }); setOpen(true) }}
              onFocus={() => setOpen(true)} />
          </div>
          {open && value.name.trim().length >= 2 && results.length > 0 && (
            <div className="absolute z-20 w-full mt-1 bg-white rounded-lg border border-gray-200 shadow-lg max-h-56 overflow-y-auto">
              {results.map((p) => (
                <button key={p.id} type="button"
                  onClick={() => {
                    onChange({ id: p.id, name: p.name, gstin: p.gstin, phone: p.phone, address: p.address })
                    setOpen(false)
                  }}
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50 border-b border-gray-50 last:border-0">
                  <div className="text-sm font-medium text-gray-900">{p.name}</div>
                  <div className="text-xs text-gray-500">
                    {[p.address?.city, p.gstin, p.phone].filter(Boolean).join(' · ')}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
