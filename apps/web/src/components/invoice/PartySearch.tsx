// src/components/invoice/PartySearch.tsx
// Invoice party field: type-ahead over saved customers (or suppliers on purchase documents).
import { PartyCombobox } from '@/components/ui/PartyCombobox'

interface Party {
  id: string
  name: string
  phone: string | null
  balance: number
  creditLimit: number
}

interface PartySearchProps {
  selected:   Party | null
  onSelect:   (party: Party | null) => void
  /** 'supplier' on purchase documents; defaults to customers. */
  partyType?: 'customer' | 'supplier'
}

export function PartySearch({ selected, onSelect, partyType = 'customer' }: PartySearchProps) {
  return (
    <PartyCombobox
      type={partyType}
      allowFreeText={false}
      placeholder={partyType === 'supplier' ? 'Search supplier…' : 'Search customer or leave blank for cash sale...'}
      value={selected ? { id: selected.id, name: selected.name, phone: selected.phone } : { name: '' }}
      onChange={(p, raw) => onSelect(p.id && raw
        ? { id: raw.id, name: raw.name, phone: raw.phone ?? null, balance: Number(raw.balance ?? 0), creditLimit: Number(raw.creditLimit ?? 0) }
        : null)}
    />
  )
}
