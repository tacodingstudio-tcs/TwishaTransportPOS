// Firms = the business names one login can work in (e.g. "Rajhansh Roadways" and "Rajhansh Enterprise").
// The server scopes every record to the active firm; this hook tells the screens which one that is.
import { useQuery } from '@tanstack/react-query'
import { transportApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

export type FirmKind = 'transport' | 'goods'

export interface Firm {
  id: string
  name: string
  kind: FirmKind
  gstin: string | null
  stateCode: string | null
  address: Record<string, any> | null
  domainConfig: Record<string, any>
  logo: string | null
  numbering: { style: 'plain' | 'standard'; prefix: string | null; next: number | null }
}

/** Accent per firm (by position) so staff always see at a glance which firm they are billing as. */
export const FIRM_TONES = [
  { bar: 'bg-emerald-500', soft: 'bg-emerald-50', ring: 'ring-emerald-300', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  { bar: 'bg-sky-500',     soft: 'bg-sky-50',     ring: 'ring-sky-300',     text: 'text-sky-700',     dot: 'bg-sky-500' },
  { bar: 'bg-violet-500',  soft: 'bg-violet-50',  ring: 'ring-violet-300',  text: 'text-violet-700',  dot: 'bg-violet-500' },
  { bar: 'bg-amber-500',   soft: 'bg-amber-50',   ring: 'ring-amber-300',   text: 'text-amber-700',   dot: 'bg-amber-500' },
  { bar: 'bg-rose-500',    soft: 'bg-rose-50',    ring: 'ring-rose-300',    text: 'text-rose-700',    dot: 'bg-rose-500' },
] as const

export const KIND_LABEL: Record<FirmKind, string> = { transport: 'Transport', goods: 'Goods / trading' }

export function useFirms() {
  return useQuery<{ currentFirmId: string; firms: Firm[] }>({
    queryKey: ['firms'],
    queryFn: transportApi.firms,
    staleTime: 5 * 60_000,         // the list carries each firm's logo (tens of KB); edits and new bills refresh it explicitly
  })
}

/** The firm being worked in right now, plus the full list and that firm's position (for its accent colour). */
export function useCurrentFirm() {
  const q = useFirms()
  const branchId = useAuthStore((s) => s.branch?.id)
  const firms = q.data?.firms ?? []
  const id = branchId ?? q.data?.currentFirmId
  const index = Math.max(0, firms.findIndex((f) => f.id === id))
  const firm = firms.find((f) => f.id === id)
  return { firm, firms, index, tone: FIRM_TONES[index % FIRM_TONES.length]!, isLoading: q.isLoading }
}

/** Initials for a firm without a logo: "Rajhansh Roadways" → "RR". */
export const firmInitials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
