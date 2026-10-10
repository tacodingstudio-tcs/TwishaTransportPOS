// Type-ahead picker for parties and suppliers — the one component every party/supplier field uses.
//
//  • suggestions appear on focus and refine on every keystroke (name, phone or GSTIN)
//  • ↑ / ↓ / Enter / Esc work; clicking a row also picks it
//  • `type` limits the list to customers or suppliers (parties marked "both" match either)
//  • allowFreeText: a name that is not a saved party is allowed (one-off consignors); otherwise only a
//    saved party can be picked
//
// Two ways to use it:
//   <PartyCombobox value={{id,name,…}} onChange={(p) => …} />          — object value (name + optional id)
//   <PartyIdSelect value={partyId} onChange={(id, p) => …} />          — drop-in for a <select> of parties
import { useEffect, useId, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { partyApi } from '@/lib/api'
import { Search, X, Building2, Loader2 } from 'lucide-react'

export interface PickedParty {
  id?:      string
  name:     string
  gstin?:   string | null
  phone?:   string | null
  address?: any
}

interface BaseProps {
  label?:       string
  required?:    boolean
  /** customer | supplier — parties of type "both" are included in either. */
  type?:        'customer' | 'supplier'
  placeholder?: string
  disabled?:    boolean
  hint?:        string
  className?:   string
}

function useDebounced<T>(value: T, ms = 180): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

interface ComboProps extends BaseProps {
  value:          PickedParty
  onChange:       (p: PickedParty, raw?: any) => void
  allowFreeText?: boolean
}

export function PartyCombobox({
  label, value, onChange, required, type, placeholder, disabled, hint, className, allowFreeText = true,
}: ComboProps) {
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  // Pick-only mode keeps what is being typed locally (the parent only ever holds a saved party).
  const [draft, setDraft] = useState('')
  const text = allowFreeText ? value.name : draft
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const search = useDebounced(text.trim())
  const { data, isFetching } = useQuery({
    queryKey: ['party-combo', type ?? 'all', search],
    queryFn:  () => partyApi.list({ search: search || undefined, type, limit: 10 }),
    enabled:  open && !value.id,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
  const results: any[] = data?.data ?? []

  useEffect(() => { setActive(0) }, [search, open])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const pick = (p: any) => {
    onChange({ id: p.id, name: p.name, gstin: p.gstin, phone: p.phone, address: p.address }, p)
    setDraft('')
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter' && open && results[active]) { e.preventDefault(); pick(results[active]) }
    else if (e.key === 'Escape') setOpen(false)
  }

  const clear = () => {
    onChange({ name: '' })
    setDraft('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <div ref={ref} className={`relative ${className ?? ''}`}>
      {label && <label className="label" htmlFor={uid}>{label}{required && ' *'}</label>}
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
          {!disabled && (
            <button type="button" title="Clear" onClick={clear} className="p-1 hover:bg-primary-100 rounded-md">
              <X className="w-4 h-4 text-gray-500" />
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              id={uid}
              ref={inputRef}
              className="input pl-9 pr-8"
              autoComplete="off"
              role="combobox"
              aria-expanded={open}
              aria-autocomplete="list"
              disabled={disabled}
              placeholder={placeholder ?? (allowFreeText ? 'Type to search, or write a new name' : 'Type to search…')}
              value={text}
              onChange={(e) => {
                if (allowFreeText) onChange({ name: e.target.value })
                else setDraft(e.target.value)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
            />
            {isFetching && open && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 animate-spin" />}
          </div>
          {open && !disabled && (
            <div role="listbox" className="absolute z-30 w-full mt-1 bg-white rounded-lg border border-gray-200 shadow-lg max-h-64 overflow-y-auto">
              {results.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(p)}
                  className={`w-full text-left px-4 py-2.5 border-b border-gray-50 last:border-0 ${i === active ? 'bg-primary-50' : 'hover:bg-gray-50'}`}
                >
                  <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                    {p.name}
                    {p.type === 'supplier' && <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 rounded px-1">Supplier</span>}
                  </div>
                  <div className="text-xs text-gray-500">
                    {[p.address?.city, p.gstin, p.phone].filter(Boolean).join(' · ')}
                  </div>
                </button>
              ))}
              {!isFetching && results.length === 0 && (
                <div className="px-4 py-3 text-sm text-gray-500">
                  {text.trim()
                    ? allowFreeText ? `No saved match — "${text.trim()}" will be used as a new name.` : `No saved ${type ?? 'party'} matches "${text.trim()}".`
                    : `No saved ${type ?? 'party'} yet.`}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}

// ── Drop-in replacement for <select> of parties ───────────────────────────────

interface IdSelectProps extends BaseProps {
  value:    string
  onChange: (id: string, party?: PickedParty) => void
}

/** Holds only a party id (like the <select> it replaces); resolves the name for display. */
export function PartyIdSelect({ value, onChange, ...rest }: IdSelectProps) {
  const [picked, setPicked] = useState<PickedParty | null>(null)

  // An id that arrived from outside (edit form) has no name yet — fetch it once.
  const { data: fetched } = useQuery({
    queryKey: ['party', value],
    queryFn:  () => partyApi.get(value),
    enabled:  !!value && picked?.id !== value,
    staleTime: 60_000,
  })
  const current: PickedParty = value
    ? (picked?.id === value ? picked : fetched ? { id: fetched.id, name: fetched.name, gstin: fetched.gstin, phone: fetched.phone } : { id: value, name: 'Loading…' })
    : { name: '' }

  return (
    <PartyCombobox
      {...rest}
      allowFreeText={false}
      value={current}
      onChange={(p) => {
        setPicked(p.id ? p : null)
        onChange(p.id ?? '', p.id ? p : undefined)
      }}
    />
  )
}
