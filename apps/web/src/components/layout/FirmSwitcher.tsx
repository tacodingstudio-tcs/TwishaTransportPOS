// Sidebar block that shows which firm you are working in and lets you switch with one tap.
// One firm → just its name and logo. Several → a short list; the active one is highlighted in its own colour.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Check, ChevronDown, Loader2, Truck, Package } from 'lucide-react'
import { authApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { FIRM_TONES, KIND_LABEL, firmInitials, useCurrentFirm, type Firm } from '@/hooks/useFirms'

export function FirmAvatar({ firm, size = 'md', toneIndex = 0 }: { firm: Pick<Firm, 'name' | 'logo' | 'kind'>; size?: 'sm' | 'md'; toneIndex?: number }) {
  const tone = FIRM_TONES[toneIndex % FIRM_TONES.length]!
  const box = size === 'sm' ? 'w-8 h-8' : 'w-10 h-10'
  if (firm.logo) {
    return (
      <span className={`${box} rounded-lg bg-white ring-1 ring-gray-200 flex items-center justify-center overflow-hidden shrink-0`}>
        <img src={firm.logo} alt="" className="max-w-full max-h-full object-contain" />
      </span>
    )
  }
  const Icon = firm.kind === 'goods' ? Package : Truck
  return (
    <span className={`${box} rounded-lg ${tone.soft} ${tone.text} flex items-center justify-center shrink-0 text-xs font-bold`}>
      {firm.name ? firmInitials(firm.name) : <Icon className="w-4 h-4" />}
    </span>
  )
}

/** Switch the working firm: new token, drop every cached screen, land on that firm's Home. */
export function useSwitchFirm() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { firm } = useCurrentFirm()
  const { branch, refreshToken, setBranch } = useAuthStore()
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)

  async function switchTo(target: Firm) {
    if (target.id === (firm?.id ?? branch?.id) || switchingTo) return
    setSwitchingTo(target.id)
    try {
      const r = await authApi.switchBranch(target.id, refreshToken)
      setBranch({
        id: r.branch.id, name: r.branch.name, domainType: r.branch.domainType,
        domainConfig: r.branch.domainConfig ?? {}, stateCode: r.branch.stateCode ?? null,
      }, r.accessToken)
      // Everything on screen belonged to the other firm — drop it all, then start from Home.
      qc.clear()
      navigate('/')
      toast.success(`Now working in ${target.name}`)
    } catch (e) {
      toast.error(apiError(e))
    } finally {
      setSwitchingTo(null)
    }
  }
  return { switchTo, switchingTo }
}

/** Small dropdown: the active firm's name; opens a list of the other firms. Renders nothing for a single-firm business. */
export function FirmMenu() {
  const { firm, firms, index, tone } = useCurrentFirm()
  const { switchTo, switchingTo } = useSwitchFirm()
  const [open, setOpen] = useState(false)
  if (firms.length <= 1 || !firm) return null
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className={`inline-flex items-center gap-2 rounded-full ${tone.soft} ${tone.text} px-3 py-1 text-xs font-semibold hover:brightness-95`}>
        <span className={`w-2 h-2 rounded-full ${tone.dot}`} /> Working as {firm.name}
        {switchingTo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="listbox" className="absolute left-0 top-full mt-1 z-50 w-64 bg-white border border-gray-200 rounded-xl shadow-lg p-1.5 print:hidden">
            <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Switch firm</div>
            {firms.map((f, i) => (
              <button key={f.id} type="button" role="option" aria-selected={i === index} disabled={!!switchingTo}
                onClick={async () => { await switchTo(f); setOpen(false) }}
                className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left ${i === index ? 'bg-gray-50' : 'hover:bg-gray-100'}`}>
                <FirmAvatar firm={f} size="sm" toneIndex={i} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-gray-800 truncate">{f.name}</span>
                  <span className="block text-[11px] text-gray-500">{KIND_LABEL[f.kind]}</span>
                </span>
                {i === index && <Check className="w-4 h-4 text-gray-500" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function FirmSwitcher() {
  const { firm, firms, index } = useCurrentFirm()
  const { branch } = useAuthStore()
  const { switchTo, switchingTo } = useSwitchFirm()

  // Not loaded yet, or a business with a single firm: a quiet header, nothing to switch.
  if (firms.length <= 1) {
    const only = firms[0]
    return (
      <div className="h-16 flex items-center gap-2.5 px-4 border-b border-gray-200">
        {only ? <FirmAvatar firm={only} /> : <span className="w-10 h-10 rounded-lg bg-primary-600 flex items-center justify-center"><Truck className="w-4 h-4 text-white" /></span>}
        <div className="overflow-hidden">
          <div className="text-sm font-semibold text-gray-900 truncate">{only?.name ?? branch?.name ?? 'Transport'}</div>
          <div className="text-xs text-gray-500 truncate">{only ? KIND_LABEL[only.kind] : ''}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="px-3 pt-3 pb-2 border-b border-gray-200">
      <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Working in</div>
      <div className="space-y-1" role="radiogroup" aria-label="Firm">
        {firms.map((f, i) => {
          const active = i === index
          const tone = FIRM_TONES[i % FIRM_TONES.length]!
          return (
            <button key={f.id} type="button" role="radio" aria-checked={active} onClick={() => switchTo(f)} disabled={!!switchingTo}
              className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors ${
                active ? `${tone.soft} ring-1 ${tone.ring}` : 'hover:bg-gray-100'}`}>
              <FirmAvatar firm={f} size="sm" toneIndex={i} />
              <span className="min-w-0 flex-1">
                <span className={`block text-[13px] font-semibold truncate ${active ? tone.text : 'text-gray-800'}`}>{f.name}</span>
                <span className="block text-[11px] text-gray-500 truncate">{KIND_LABEL[f.kind]}</span>
              </span>
              {switchingTo === f.id ? <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                : active ? <Check className={`w-4 h-4 ${tone.text}`} /> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
