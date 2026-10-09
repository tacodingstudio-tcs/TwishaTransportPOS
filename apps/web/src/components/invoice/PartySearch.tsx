// src/components/invoice/PartySearch.tsx
import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { partyApi } from '@/lib/api'
import { Search, User, X } from 'lucide-react'

interface Party {
  id: string
  name: string
  phone: string | null
  balance: number
  creditLimit: number
}

interface PartySearchProps {
  selected:  Party | null
  onSelect:  (party: Party | null) => void
}

export function PartySearch({ selected, onSelect }: PartySearchProps) {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data } = useQuery({
    queryKey: ['party-search', query],
    queryFn:  () => partyApi.list({ search: query, type: 'customer', limit: 8 }),
    enabled:  query.trim().length >= 2,
  })

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  if (selected) {
    return (
      <div className="flex items-center justify-between px-3 py-2 bg-primary-50 border border-primary-200 rounded-lg">
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 text-primary-600" />
          <div>
            <div className="text-sm font-medium text-gray-900">{selected.name}</div>
            {selected.phone && <div className="text-xs text-gray-500">{selected.phone}</div>}
          </div>
        </div>
        <button type="button" title="Clear customer" onClick={() => onSelect(null)} className="p-1 hover:bg-primary-100 rounded-md">
          <X className="w-4 h-4 text-gray-500" />
        </button>
      </div>
    )
  }

  const results: Party[] = data?.data ?? []

  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          placeholder="Search customer or leave blank for cash sale..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIsOpen(true) }}
          onFocus={() => setIsOpen(true)}
          className="input pl-9"
        />
      </div>

      {isOpen && query.trim().length >= 2 && (
        <div className="absolute z-20 w-full mt-1 bg-white rounded-lg border border-gray-200 shadow-lg max-h-64 overflow-y-auto">
          {results.length === 0 && (
            <div className="px-4 py-3 text-sm text-gray-400">No customers found</div>
          )}
          {results.map((party) => (
            <button
              key={party.id}
              type="button"
              onClick={() => { onSelect(party); setIsOpen(false); setQuery('') }}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left border-b border-gray-50 last:border-0"
            >
              <div>
                <div className="text-sm font-medium text-gray-900">{party.name}</div>
                <div className="text-xs text-gray-500">{party.phone}</div>
              </div>
              {party.balance > 0 && (
                <span className="text-xs text-amber-600 font-medium">
                  ₹{party.balance} due
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
