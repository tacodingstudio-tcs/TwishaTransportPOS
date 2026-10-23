// src/pages/LoginPage.tsx
// Twisha Transport POS sign-in. Left: a night-drive hero — trucks running a Surat → Ahmedabad → Jaipur route under a
// starry sky and skyline, each stop calling out what the product just did there, and a live activity ticker along the
// bottom. Right: a calm sign-in card with a 4-box PIN.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Loader2, Phone, ArrowRight, Check, MapPin, Receipt, Truck as TruckIcon, ShieldCheck, FileText, Fuel, Route } from 'lucide-react'
import toast from 'react-hot-toast'
import { PoweredByBadge } from '@/components/PoweredBy'
import { PRODUCT_NAME } from '@/lib/branding'

const CSS = `
@keyframes tx-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }
@keyframes tx-rise  { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: none } }
@keyframes tx-glow  { 0%,100% { opacity: .5 } 50% { opacity: .85 } }
@keyframes tx-sweep { from { background-position: -200% 0 } to { background-position: 200% 0 } }
@keyframes tx-dash  { to { stroke-dashoffset: -40 } }
@keyframes tx-twinkle { 0%,100% { opacity: .15 } 50% { opacity: .95 } }
@keyframes tx-pop   { from { opacity: 0; transform: translate(var(--tx), var(--ty)) scale(.85) } to { opacity: 1; transform: translate(var(--tx), var(--ty)) scale(1) } }
@keyframes tx-marquee { to { transform: translateX(-50%) } }
@keyframes tx-shoot { 0%,6% { opacity: 0; transform: translate(0,0) rotate(32deg) } 8% { opacity: 1 } 16% { opacity: 0; transform: translate(260px,162px) rotate(32deg) } 100% { opacity: 0; transform: translate(260px,162px) rotate(32deg) } }
@keyframes tx-drift { from { transform: translateX(0) } to { transform: translateX(-50%) } }
@keyframes tx-win   { 0%,100% { opacity: .9 } 50% { opacity: .25 } }
.tx-float { animation: tx-float 5s ease-in-out infinite }
.tx-rise  { animation: tx-rise .7s cubic-bezier(.2,.7,.2,1) both }
.tx-glow  { animation: tx-glow 5s ease-in-out infinite }
.tx-dash  { animation: tx-dash 2.4s linear infinite }
.tx-star  { animation: tx-twinkle 4s ease-in-out infinite }
.tx-win   { animation: tx-win 6s ease-in-out infinite }
.tx-pop   { animation: tx-pop .6s cubic-bezier(.2,.8,.2,1) both }
.tx-marquee { animation: tx-marquee 42s linear infinite }
.tx-shoot { animation: tx-shoot 11s ease-out infinite }
.tx-drift { animation: tx-drift 140s linear infinite }
.tx-title { background: linear-gradient(100deg,#fff 20%,#fcd34d 45%,#fff 70%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: tx-sweep 7s linear infinite }
@keyframes tx-drive { from { transform: translateX(-240px) } to { transform: translateX(calc(100cqw + 40px)) } }
@keyframes tx-spin  { to { transform: rotate(360deg) } }
@keyframes tx-bob   { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-1.5px) } }
.tx-drive { animation: tx-drive var(--dur, 22s) linear var(--delay, 0s) infinite }
.tx-spin  { transform-box: fill-box; transform-origin: center; animation: tx-spin .55s linear infinite }
.tx-bob   { animation: tx-bob .7s ease-in-out infinite }
@keyframes tx-cycle { 0% { opacity: 0; transform: translateY(8px) } 6%,28% { opacity: 1; transform: none } 34%,100% { opacity: 0; transform: translateY(-4px) } }
.tx-cycle { animation: tx-cycle 12s ease-in-out var(--cd, 0s) infinite both }
@media (prefers-reduced-motion: reduce) { .tx-drive { animation: none; transform: translateX(var(--rest, 20cqw)) } .tx-spin,.tx-bob { animation: none } .tx-cycle { animation: none; opacity: 0 } .tx-cycle-first { opacity: 1 } .tx-float,.tx-rise,.tx-glow,.tx-dash,.tx-title,.tx-star,.tx-win,.tx-pop,.tx-marquee,.tx-shoot,.tx-drift { animation: none } .tx-pop { opacity: 1; transform: translate(var(--tx), var(--ty)) } }
`

/** Two ridges of hills behind the city; the far one drifts very slowly. */
function Hills() {
  const ridge = 'M0,80 C60,40 110,60 170,45 S280,20 340,50 S450,70 500,40 S600,25 660,55 S760,75 800,60 L800,120 L0,120 Z'
  return (
    <div className="absolute inset-x-0 bottom-[11rem] h-48 overflow-hidden pointer-events-none" aria-hidden="true">
      <div className="absolute inset-y-0 left-0 w-[200%] flex tx-drift opacity-70">
        {[0, 1].map((i) => (
          <svg key={i} viewBox="0 0 800 120" preserveAspectRatio="none" className="w-1/2 h-full"><path d={ridge} fill="#9ad8a6" /></svg>
        ))}
      </div>
      <svg viewBox="0 0 800 120" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 w-full h-3/4 opacity-90">
        <path d="M0,70 C90,30 160,80 260,55 S420,25 520,60 S700,85 800,45 L800,120 L0,120 Z" fill="#6cc283" />
      </svg>
    </div>
  )
}

/** A truck seen from the side. Faces right; the wheels turn. */
function TruckArt({ cab, cabEdge, className = '' }: { cab: string; cabEdge: string; className?: string }) {
  return (
    <svg viewBox="-34 -20 106 36" className={className} overflow="visible">
      <g className="tx-bob">
        <rect x="-30" y="-17" width="38" height="22" rx="3" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1" />
        <rect x="-26" y="-12" width="30" height="3" rx="1.5" fill={cab} />
        <rect x="-26" y="-6" width="20" height="3" rx="1.5" fill="#cbd5e1" />
        <path d="M10,-11 h10 l7,8 v8 h-17 z" fill={cab} stroke={cabEdge} strokeWidth="1" />
        <path d="M13,-8 h5 l4,5 h-9 z" fill="#bae6fd" />
        {[-20, -9, 18].map((x) => (
          <g key={x} className="tx-spin">
            <circle cx={x} cy="7" r="4.6" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1.5" />
            <circle cx={x + 2.3} cy="7" r="0.9" fill="#94a3b8" />
            <circle cx={x - 2.3} cy="7" r="0.9" fill="#94a3b8" />
          </g>
          ))}
        {[-20, -9, 18].map((x) => (
          <circle key={`hub${x}`} cx={x} cy="7" r="1.7" fill="#e2e8f0" />
        ))}
      </g>
    </svg>
  )
}

/** What the product just did, as a small card. */
function Chip({ Icon, title, sub, tone }: { Icon: React.ElementType; title: string; sub: string; tone: string }) {
  return (
    <div className="w-max rounded-xl bg-slate-950/70 backdrop-blur-md ring-1 ring-white/20 shadow-xl shadow-black/30 px-3 py-2">
      <div className={`flex items-center gap-1.5 text-[13px] font-bold ${tone}`}><Icon className="w-3.5 h-3.5" />{title}</div>
      <div className="text-[11px] text-white/60 mt-0.5">{sub}</div>
    </div>
  )
}

/** Green highway board, like the ones on the Indian expressways. */
function Sign({ name, left }: { name: string; left: string }) {
  return (
    <div className="absolute bottom-[184px]" style={{ left }}>
      <div className="rounded-md bg-emerald-700 text-white text-xs font-bold tracking-[0.18em] text-center px-4 py-1.5 ring-2 ring-white shadow-md">{name}</div>
      <div className="w-1.5 h-10 bg-slate-500 mx-auto" />
    </div>
  )
}

/** The foreground: grass, a straight highway, the signs of the three cities, two trucks driving past, and cards that ride on them. */
function Highway() {
  return (
    <div className="absolute inset-x-0 bottom-0 h-[340px] pointer-events-none" aria-hidden="true">
      <div className="absolute inset-x-0 bottom-0 h-[230px]" style={{ background: 'linear-gradient(180deg, #86d79b 0%, #5db97a 100%)' }} />
      <Sign name="SURAT" left="9%" />
      <Sign name="AHMEDABAD" left="44%" />
      <Sign name="JAIPUR" left="78%" />
      {/* the road */}
      <div className="absolute inset-x-0 bottom-[88px] h-24 bg-[#2b3445] border-y-4 border-white/90">
        <div className="absolute inset-x-0 top-1/2 -mt-0.5 h-1" style={{ background: 'repeating-linear-gradient(90deg, #fde68a 0 34px, transparent 34px 68px)' }} />
      </div>
      {/* far lane: smaller and slower */}
      <div className="absolute left-0 bottom-[142px] w-[210px] tx-drive" style={{ ['--dur' as string]: '34s', ['--delay' as string]: '-23s', ['--rest' as string]: '58cqw' }}>
        <TruckArt cab="#38bdf8" cabEdge="#0369a1" className="w-full" />
      </div>
      {/* near lane: big, with what the product just did riding on it, one card at a time */}
      <div className="absolute left-0 bottom-[94px] w-[300px] tx-drive" style={{ ['--dur' as string]: '24s', ['--delay' as string]: '-9s', ['--rest' as string]: '22cqw' }}>
        <div className="absolute left-1/2 bottom-full mb-3 w-0 h-0">
          {[
            [MapPin, '3 LRs loaded', 'Trip T-0042 started', 'text-amber-300', '0s'],
            [Check, 'POD received ✓', 'LR 1187 · Arvind Textiles', 'text-emerald-300', '4s'],
            [Receipt, 'Freight bill ready', 'GST + TDS worked out', 'text-sky-300', '8s'],
          ].map(([Icon, title, sub, tone, d], k) => (
            <div key={k as number} className="absolute bottom-0 -translate-x-1/2">
              <div className={`tx-cycle ${k === 0 ? 'tx-cycle-first' : ''}`} style={{ ['--cd' as string]: d as string }}>
                <Chip Icon={Icon as React.ElementType} title={title as string} sub={sub as string} tone={tone as string} />
              </div>
            </div>
          ))}
        </div>
        <TruckArt cab="#f59e0b" cabEdge="#b45309" className="w-full" />
      </div>
    </div>
  )
}

const TICKER = [
  ['LR 1187 delivered', 'Surat → Ahmedabad'],
  ['Freight bill #42 sent', '₹4,48,239 · GST + TDS'],
  ['₹14,200 paid to Sharma Pump', 'diesel on account'],
  ['Trip T-0042 profit', '₹30,650 · 64% margin'],
  ['e-way bill generated', 'valid 3 days'],
  ['POD uploaded', 'LR 1190'],
]

function Ticker() {
  const items = [...TICKER, ...TICKER]
  return (
    <div className="absolute inset-x-0 bottom-6 overflow-hidden" aria-hidden="true"
      style={{ maskImage: 'linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)', WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)' }}>
      <div className="flex w-max gap-3 tx-marquee">
        {items.map(([a, b], i) => (
          <span key={i} className="inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-white/75 ring-1 ring-slate-300/70 backdrop-blur px-3.5 py-1.5 text-xs shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="font-semibold text-slate-800">{a}</span><span className="text-slate-500">{b}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Four boxes, one digit each: type, paste, backspace and arrows all behave. */
function PinBoxes({ value, onChange, onComplete }: { value: string; onChange: (v: string) => void; onComplete?: (pin: string) => void }) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const digits = value.padEnd(4, ' ').split('')
  const set = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, 4)
    onChange(clean)
    if (clean.length === 4) onComplete?.(clean)
  }
  return (
    <div className="flex gap-3 justify-between" role="group" aria-label="4-digit PIN">
      {[0, 1, 2, 3].map((i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el }}
          id={i === 0 ? 'login-pin' : undefined}
          type="password" inputMode="numeric" autoComplete="off" maxLength={1}
          aria-label={`PIN digit ${i + 1}`}
          value={digits[i] === ' ' ? '' : digits[i]}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, '').slice(-1)
            const arr = value.padEnd(4, ' ').split('')
            arr[i] = d || ' '
            set(arr.join('').replace(/ /g, ''))
            if (d && i < 3) refs.current[i + 1]?.focus()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i]?.trim() && i > 0) { refs.current[i - 1]?.focus() }
            if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus()
            if (e.key === 'ArrowRight' && i < 3) refs.current[i + 1]?.focus()
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4)
            if (t) { e.preventDefault(); set(t); refs.current[Math.min(t.length, 3)]?.focus() }
          }}
          className="w-full h-14 text-center text-2xl font-bold rounded-xl border border-slate-300 bg-white text-slate-900
                     focus:border-amber-400 focus:ring-4 focus:ring-amber-100 outline-none transition
                     data-[filled=true]:border-slate-900 data-[filled=true]:bg-slate-900 data-[filled=true]:text-white"
          data-filled={!!digits[i]?.trim()}
        />
      ))}
    </div>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth  = useAuthStore((s) => s.setAuth)
  const [phone, setPhone] = useState('')
  const [pin, setPin]     = useState('')
  const greeting = useMemo(() => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  }, [])

  // The server sleeps when nobody has used it for a while and takes up to a minute to wake. Knock on its door the
  // moment this page opens, so it is already waking while the person types their number and PIN.
  const [waking, setWaking] = useState(false)
  useEffect(() => { fetch('/api/tenants/domains', { cache: 'no-store' }).catch(() => {}) }, [])

  const loginMutation = useMutation({
    mutationFn: async (p: string) => {
      // A sleeping server answers 502 / 503 / 504 (or nothing at all) until it is up: wait and try again for about
      // a minute instead of telling the person their PIN is wrong.
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await authApi.login(phone, p)
          setWaking(false)
          return out
        } catch (err: any) {
          const status = err?.response?.status as number | undefined
          const asleep = !status || status === 502 || status === 503 || status === 504
          if (!asleep || attempt >= 7) { setWaking(false); throw err }
          setWaking(true); toast.dismiss()
          await new Promise((r) => setTimeout(r, 8000))
        }
      }
    },
    onSuccess: (data) => {
      setAuth(data.accessToken, data.refreshToken, data.accessTokenExpiresIn, data.user, data.tenant, data.branch)
      toast.success(`Welcome back, ${data.user.name}!`)
      navigate('/')
    },
    onError: (err: any) => {
      // Replace the api layer's toast with one clear message of ours.
      const st = err?.response?.status as number | undefined
      toast.dismiss()
      if (!st || st === 502 || st === 503 || st === 504) toast.error('The server is not answering yet — wait a minute and try again')
      else toast.error(st === 429 ? 'Too many tries — wait a minute' : 'Wrong phone number or PIN')
      // start the PIN again from the first box (a half-edited old PIN would otherwise re-submit on the 4th digit)
      setPin('')
      setTimeout(() => document.getElementById('login-pin')?.focus(), 30)
    },
  })

  const ready = phone.length >= 10 && pin.length === 4
  function submit() {
    if (!ready || loginMutation.isPending) return
    loginMutation.mutate(pin)
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.15fr_1fr] bg-white">
      <style>{CSS}</style>

      {/* ══ Hero ═══════════════════════════════════════════════════════════════════ */}
      <aside className="hidden lg:flex relative overflow-hidden flex-col p-12 text-slate-900"
        style={{ background: 'linear-gradient(180deg, #6ec6f5 0%, #a9dcf8 38%, #d9f0fb 66%, #c8e8c3 100%)', containerType: 'inline-size' }}>
        {/* horizon glow */}
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-white/40 to-transparent tx-glow" aria-hidden="true" />
        {/* sun + a few slow clouds */}
        <div className="absolute right-12 top-20 w-16 h-16 xl:right-14 xl:w-24 xl:h-24 rounded-full pointer-events-none tx-glow" aria-hidden="true"
          style={{ background: 'radial-gradient(circle at 40% 38%, #fffbeb 0%, #fde68a 60%, #fbbf24 120%)', boxShadow: '0 0 80px 30px rgba(253,230,138,0.55)' }} />
        {[['left-[50%]', 'top-[9%]', '1'], ['left-[66%]', 'top-[27%]', '.8'], ['left-[58%]', 'top-[45%]', '.9']].map(([l, tp, sc], n) => (
          <div key={n} className={`absolute ${l} ${tp} tx-float pointer-events-none`} style={{ transform: `scale(${sc})`, animationDelay: `${n * 1.4}s` }} aria-hidden="true">
            <span className="block w-28 h-8 rounded-full bg-white/90" />
            <span className="absolute -top-4 left-4 w-12 h-12 rounded-full bg-white/90" />
            <span className="absolute -top-7 left-11 w-14 h-14 rounded-full bg-white/90" />
          </div>
        ))}
        <Hills />

        <header className="relative tx-rise">
          {/* transparent logo; the light variant has the navy lettering turned white so it reads on the night sky */}
          <img src="/twisha-pos-logo.png" alt={PRODUCT_NAME} className="h-16 w-auto" width={243} height={64} />
        </header>

        <div className="relative mt-14 [@media(max-height:760px)]:mt-8 max-w-xl">
          <p className="tx-rise inline-flex items-center gap-3 text-amber-700 text-sm font-semibold tracking-[0.2em] uppercase" style={{ animationDelay: '.05s' }}>
            <span className="w-8 h-px bg-amber-600/70" /> Fleet & freight billing · Transporters
          </p>
          <h1 className="tx-rise mt-4 text-slate-900 text-5xl xl:text-6xl [@media(max-height:760px)]:text-4xl xl:[@media(max-height:760px)]:text-5xl font-extrabold leading-[1.05] tracking-tight" style={{ animationDelay: '.12s' }}>
            Every load.<br />Every trip.<br /><span className="bg-gradient-to-r from-amber-500 via-orange-500 to-orange-600 bg-clip-text text-transparent">Every rupee.</span>
          </h1>
          <p className="tx-rise mt-6 [@media(max-height:760px)]:mt-4 text-lg [@media(max-height:760px)]:text-base text-slate-700 max-w-sm leading-relaxed" style={{ animationDelay: '.2s' }}>
            Book the LR, run the trip, collect the POD, send the GST bill — and know what each truck really earned.
          </p>
        </div>

        <Highway />

        <Ticker />
      </aside>

      {/* ══ Sign in ════════════════════════════════════════════════════════════════ */}
      <main className="relative overflow-hidden flex flex-col px-5 py-8 lg:px-10 z-10 shadow-[-8px_0_30px_rgba(15,23,42,0.10)]"
        style={{ background: 'linear-gradient(160deg, #ffffff 0%, #f8fafc 45%, #fff7ed 100%)' }}>
        {/* a faint road winding behind the card */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 600 900" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
          <path d="M-40,860 C140,740 220,880 360,770 S560,620 660,660" fill="none" stroke="#f59e0b" strokeOpacity="0.28" strokeWidth="3" strokeDasharray="10 12" strokeLinecap="round" />
          <path d="M-40,120 C120,60 220,170 340,110 S520,40 660,90" fill="none" stroke="#0f172a" strokeOpacity="0.07" strokeWidth="3" strokeDasharray="10 12" strokeLinecap="round" />
          <circle cx="360" cy="770" r="6" fill="#f59e0b" fillOpacity="0.35" />
          <circle cx="340" cy="110" r="6" fill="#0f172a" fillOpacity="0.12" />
        </svg>

        {/* dot grid + glow, so the panel never reads as empty */}
        <div className="absolute inset-0 opacity-[0.5] pointer-events-none" aria-hidden="true"
          style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: '24px 24px', maskImage: 'radial-gradient(ellipse at 60% 40%, #000 0%, transparent 72%)', WebkitMaskImage: 'radial-gradient(ellipse at 60% 40%, #000 0%, transparent 72%)' }} />
        <div className="absolute -top-24 -right-24 w-[26rem] h-[26rem] rounded-full bg-amber-300/25 blur-3xl pointer-events-none" aria-hidden="true" />
        <div className="absolute -bottom-32 -left-20 w-[22rem] h-[22rem] rounded-full bg-emerald-300/20 blur-3xl pointer-events-none" aria-hidden="true" />

        <div className="relative flex-1 flex flex-col items-center justify-center py-6">
        <div className="w-full max-w-md tx-rise">

          {/* small screens: compact brand */}
          <div className="lg:hidden text-center mb-6">
            <img src="/twisha-pos-logo.png" alt={PRODUCT_NAME} className="h-14 w-auto mx-auto" width={213} height={56} />
            <div className="mt-2 text-xs text-gray-500">Every load. Every trip. Every rupee.</div>
          </div>

          <div className="relative rounded-3xl bg-white/90 backdrop-blur ring-1 ring-slate-200/80 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.25)] overflow-hidden">
            <div className="h-1.5 bg-gradient-to-r from-amber-400 via-amber-300 to-emerald-400" />
            <div className="p-7 sm:p-8">

              <div className="flex items-center gap-3">
                <span className="w-11 h-11 rounded-2xl bg-slate-900 flex items-center justify-center shadow-lg shadow-slate-900/20"><TruckIcon className="w-5 h-5 text-amber-300" /></span>
                <div>
                  <p className="text-xs font-semibold text-amber-600">{greeting} 👋</p>
                  <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight leading-tight">Welcome back</h2>
                </div>
              </div>
              <p className="text-sm text-slate-500 mt-3">Sign in to run your trucks, trips and freight bills.</p>

              <form onSubmit={(e) => { e.preventDefault(); submit() }} className="mt-6 space-y-5">
                <div>
                  <label className="label" htmlFor="login-phone">Phone number</label>
                  <div className="flex rounded-xl border border-slate-300 bg-white overflow-hidden transition focus-within:border-amber-400 focus-within:ring-4 focus-within:ring-amber-100">
                    <span className="flex items-center gap-1.5 px-3.5 bg-slate-50 border-r border-slate-200 text-sm font-semibold text-slate-600 select-none">
                      <Phone className="w-4 h-4 text-slate-400" /> +91
                    </span>
                    <input
                      id="login-phone" type="tel" inputMode="numeric" maxLength={10} placeholder="98765 43210" autoFocus
                      value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                      className="w-full h-12 px-3.5 bg-transparent text-base tracking-wide outline-none"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-baseline justify-between">
                    <label className="label" htmlFor="login-pin">4-digit PIN</label>
                    <span className="text-[11px] text-slate-400">signs in automatically</span>
                  </div>
                  <PinBoxes value={pin} onChange={setPin} onComplete={(p) => { if (phone.length >= 10 && !loginMutation.isPending) loginMutation.mutate(p) }} />
                </div>

                <button type="submit" disabled={!ready || loginMutation.isPending}
                  className="group w-full h-12 rounded-xl font-semibold text-white flex items-center justify-center gap-2.5
                             bg-gradient-to-r from-slate-900 to-slate-700 shadow-lg shadow-slate-900/25
                             hover:shadow-xl hover:shadow-slate-900/30 hover:-translate-y-px active:translate-y-0
                             disabled:from-slate-300 disabled:to-slate-300 disabled:shadow-none disabled:hover:translate-y-0 transition-all">
                  {loginMutation.isPending
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing you in…</>
                    : <>Sign in <span className="w-6 h-6 rounded-full bg-amber-400 text-slate-900 flex items-center justify-center transition-transform group-hover:translate-x-0.5 group-disabled:bg-white/60"><ArrowRight className="w-3.5 h-3.5" /></span></>}
                </button>
                {waking && (
                  <p role="status" className="text-center text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    The server was asleep and is waking up — this takes up to a minute. Please wait, you will be signed in automatically.
                  </p>
                )}
              </form>

              <div className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> Your PIN is never stored or shown
              </div>
            </div>
          </div>

          {/* what is inside, for people who have not seen it yet */}
          <div className="hidden sm:grid [@media(max-height:830px)]:hidden grid-cols-3 gap-3 mt-6">
            {([
              [FileText, 'GST freight bills', 'with TDS'],
              [Fuel, 'Pump payables', 'diesel on account'],
              [Route, 'LR → POD → Bill', 'one chain'],
            ] as const).map(([Icon, a, b]) => (
              <div key={a} className="rounded-2xl bg-white/70 backdrop-blur ring-1 ring-slate-200/80 px-3 py-3 text-center">
                <span className="mx-auto w-8 h-8 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center"><Icon className="w-4 h-4" /></span>
                <div className="mt-2 text-xs font-semibold text-slate-800 leading-tight">{a}</div>
                <div className="text-[11px] text-slate-400">{b}</div>
              </div>
            ))}
          </div>

          <div className="mt-7 flex justify-center"><PoweredByBadge /></div>
        </div>
        </div>
      </main>
    </div>
  )
}
