import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { transportApi } from '@/lib/api'

interface CityInputProps {
  value:        string
  onChange:     (v: string) => void
  placeholder?: string
}

/** Free-text city field that suggests cities already used in LRs and the rate card. */
export function CityInput({ value, onChange, placeholder }: CityInputProps) {
  const listId = useId()
  const { data: cities = [] } = useQuery({
    queryKey: ['transport-cities'], queryFn: transportApi.cities, staleTime: 60_000,
  })
  return (
    <>
      <input className="input" list={listId} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {cities.map((c: string) => <option key={c} value={c} />)}
      </datalist>
    </>
  )
}
