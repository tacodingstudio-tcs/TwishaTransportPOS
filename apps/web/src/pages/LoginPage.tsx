// src/pages/LoginPage.tsx
// Twisha Transport POS sign-in. Left: a night-drive hero — trucks running a Surat → Ahmedabad → Jaipur route under a
// starry sky and skyline, each stop calling out what the product just did there, and a live activity ticker along the
// bottom. Right: a calm sign-in card with a 4-box PIN.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Loader2, Phone, ArrowRight, Check, MapPin, Receipt, Truck as TruckIcon, Users, ShieldCheck, FileText, Fuel, Route } from 'lucide-react'
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
@keyframes tx-win   { 0%,100% { opacity: .9 } 50% { opacity: .25 } }
.tx-float { animation: tx-float 5s ease-in-out infinite }
.tx-rise  { animation: tx-rise .7s cubic-bezier(.2,.7,.2,1) both }
.tx-glow  { animation: tx-glow 5s ease-in-out infinite }
.tx-dash  { animation: tx-dash 2.4s linear infinite }
.tx-star  { animation: tx-twinkle 4s ease-in-out infinite }
.tx-win   { animation: tx-win 6s ease-in-out infinite }
.tx-pop   { animation: tx-pop .6s cubic-bezier(.2,.8,.2,1) both }
.tx-marquee { animation: tx-marquee 42s linear infinite }
.tx-title { background: linear-gradient(100deg,#fff 20%,#fcd34d 45%,#fff 70%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: tx-sweep 7s linear infinite }
@media (prefers-reduced-motion: reduce) { .tx-float,.tx-rise,.tx-glow,.tx-dash,.tx-title,.tx-star,.tx-win,.tx-pop,.tx-marquee { animation: none } .tx-pop { opacity: 1; transform: translate(var(--tx), var(--ty)) } }
`

const ROUTE = 'M34,262 C170,262 190,150 330,166 S540,112 606,44'
const VB = { w: 640, h: 300 }

// Stops along the route; the callout cards are HTML laid over the SVG using the same coordinates.
type Stop = { x: number; y: number; name: string; labelDy: number; labelDx?: number; title: string; sub: string; Icon: React.ElementType; tone: string; shift: string; up: number; delay: string }
const STOPS: Stop[] = [
  { x: 34,  y: 262, name: 'SURAT',     labelDy: 28,  title: '3 LRs loaded',     sub: 'Trip T-0042 started',        Icon: MapPin,  tone: 'text-amber-300',   shift: '-12%', up: 44, delay: '.9s' },
  { x: 330, y: 166, name: 'AHMEDABAD', labelDy: 28,  title: 'POD received ✓',   sub: 'LR 1187 · Arvind Textiles',  Icon: Check,   tone: 'text-emerald-300', shift: '-50%', up: 40, delay: '1.2s' },
  { x: 606, y: 44,  name: 'JAIPUR',    labelDy: 4,  labelDx: 16,  title: 'Freight bill ready', sub: 'GST + TDS worked out',      Icon: Receipt, tone: 'text-sky-300',     shift: '-62%', up: 34, delay: '1.5s' },
]

/** Deterministic star field so SSR/hydration and reloads look the same. */
function useStars(n: number) {
  return useMemo(() => {
    let s = 7
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
    return Array.from({ length: n }, () => ({ x: rnd() * 100, y: rnd() * 62, r: 0.6 + rnd() * 1.3, d: rnd() * 4 }))
  }, [n])
}

/** City silhouette along the bottom: dark blocks with a few windows still lit. */
function Skyline() {
  const blocks = useMemo(() => {
    let s = 11
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
    let x = 0
    const out: { x: number; w: number; h: number; wins: { x: number; y: number; d: number }[] }[] = []
    while (x < 1000) {
      const w = 28 + rnd() * 44, h = 26 + rnd() * 86
      const wins = Array.from({ length: Math.floor(rnd() * 5) }, () => ({ x: 5 + rnd() * (w - 12), y: 8 + rnd() * (h - 16), d: rnd() * 6 }))
      out.push({ x, w, h, wins }); x += w + 2
    }
    return out
  }, [])
  return (
    <svg viewBox="0 0 1000 130" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 w-full h-28 opacity-90" aria-hidden="true">
      <defs><linearGradient id="tx-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#13213b" /><stop offset="1" stopColor="#070d1a" /></linearGradient></defs>
      {blocks.map((b, i) => (
        <g key={i}>
          <rect x={b.x} y={130 - b.h} width={b.w} height={b.h} fill="url(#tx-sky)" />
          {b.wins.map((w, j) => <rect key={j} x={b.x + w.x} y={130 - b.h + w.y} width="3" height="4" fill="#fbbf24" className="tx-win" style={{ animationDelay: `${w.d}s` }} />)}
        </g>
      ))}
    </svg>
  )
}

function Truck({ cab = '#f59e0b', cabEdge = '#b45309' }: { cab?: string; cabEdge?: string }) {
  return (
    <g transform="scale(1.35)">
      <rect x="-30" y="-17" width="38" height="22" rx="3" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1" />
      <rect x="-26" y="-12" width="30" height="3" rx="1.5" fill={cab} />
      <rect x="-26" y="-6" width="20" height="3" rx="1.5" fill="#cbd5e1" />
      <path d="M10,-11 h10 l7,8 v8 h-17 z" fill={cab} stroke={cabEdge} strokeWidth="1" />
      <path d="M13,-8 h5 l4,5 h-9 z" fill="#bae6fd" />
      {[-20, -9, 18].map((x) => <circle key={x} cx={x} cy="7" r="4.6" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1.5" />)}
      {/* headlight beam */}
      <path d="M27,-1 L70,-12 L70,10 Z" fill="#fde68a" fillOpacity="0.16" />
    </g>
  )
}

/** The route: a lit road, pulsing stops, two trucks driving it (they stand still for reduced-motion users). */
function RouteArt({ className = '' }: { className?: string }) {
  const still = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, [])
  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} className={className} aria-hidden="true" overflow="visible">
      <defs><path id="tx-route" d={ROUTE} /></defs>
      <use href="#tx-route" fill="none" stroke="#f59e0b" strokeOpacity="0.12" strokeWidth="46" strokeLinecap="round" />
      <use href="#tx-route" fill="none" stroke="#0b1220" strokeWidth="32" strokeLinecap="round" />
      <use href="#tx-route" fill="none" stroke="#1e293b" strokeWidth="28" strokeLinecap="round" />
      <use href="#tx-route" fill="none" stroke="#fde68a" strokeWidth="2.5" strokeDasharray="14 14" strokeLinecap="round" className="tx-dash" />
      {STOPS.map((s) => (
        <g key={s.name}>
          {!still && (
            <circle cx={s.x} cy={s.y} r="8" fill="none" stroke="#fbbf24" strokeWidth="1.5">
              <animate attributeName="r" from="8" to="26" dur="2.6s" repeatCount="indefinite" />
              <animate attributeName="opacity" from="0.8" to="0" dur="2.6s" repeatCount="indefinite" />
            </circle>
          )}
          <circle cx={s.x} cy={s.y} r="11" fill="#fbbf24" fillOpacity="0.18" />
          <circle cx={s.x} cy={s.y} r="5.5" fill="#fbbf24" stroke="#fff7ed" strokeWidth="2" />
          <text x={s.x + (s.labelDx ?? 0)} y={s.y + s.labelDy} textAnchor={s.labelDx ? 'start' : 'middle'} fontSize="11" fontWeight="700" fill="#fde68a" letterSpacing="1.5">{s.name}</text>
        </g>
      ))}
      {/* truck 1 amber, truck 2 sky — second one is half a lap behind */}
      <g>
        {!still && <animateMotion dur="16s" repeatCount="indefinite" rotate="auto"><mpath href="#tx-route" /></animateMotion>}
        <g transform={still ? 'translate(330 166)' : undefined}><Truck /></g>
      </g>
      <g>
        {!still && <animateMotion dur="16s" begin="-8s" repeatCount="indefinite" rotate="auto"><mpath href="#tx-route" /></animateMotion>}
        <g transform={still ? 'translate(180 215)' : undefined}><Truck cab="#38bdf8" cabEdge="#0369a1" /></g>
      </g>
    </svg>
  )
}

/** Small "what just happened" card pinned to a stop. */
function Callout({ s }: { s: Stop }) {
  const I = s.Icon
  return (
    <div className="absolute pointer-events-none" style={{ left: `${(s.x / VB.w) * 100}%`, top: `${(s.y / VB.h) * 100}%` }}>
      <div className="tx-pop w-max rounded-xl bg-slate-950/70 backdrop-blur-md ring-1 ring-white/20 shadow-xl shadow-black/40 px-3 py-2"
        style={{ ['--tx' as string]: s.shift, ['--ty' as string]: `calc(-100% - ${s.up}px)`, animationDelay: s.delay, transform: `translate(${s.shift}, calc(-100% - ${s.up}px))` }}>
        <div className={`flex items-center gap-1.5 text-[13px] font-bold ${s.tone}`}><I className="w-3.5 h-3.5" />{s.title}</div>
        <div className="text-[11px] text-white/60 mt-0.5">{s.sub}</div>
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
          <span key={i} className="inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-white/[0.07] ring-1 ring-white/15 backdrop-blur px-3.5 py-1.5 text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="font-semibold text-white/90">{a}</span><span className="text-white/50">{b}</span>
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
  const [bizPhone, setBizPhone] = useState('')
  const [isStaff, setIsStaff]   = useState(false)
  const stars = useStars(46)
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
          const out = await authApi.login(phone, p, isStaff ? bizPhone : undefined)
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

  const ready = phone.length >= 10 && pin.length === 4 && (!isStaff || bizPhone.length >= 10)
  function submit() {
    if (!ready || loginMutation.isPending) return
    loginMutation.mutate(pin)
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.15fr_1fr] bg-[#070d1a]">
      <style>{CSS}</style>

      {/* ══ Hero ═══════════════════════════════════════════════════════════════════ */}
      <aside className="hidden lg:flex relative overflow-hidden flex-col p-12 text-white"
        style={{ background: 'linear-gradient(180deg, #0a1428 0%, #10223f 52%, #2a2a2e 86%, #3b2a14 100%)' }}>
        {/* stars */}
        <div className="absolute inset-x-0 top-0 h-3/5" aria-hidden="true">
          {stars.map((s, i) => (
            <span key={i} className="absolute rounded-full bg-white tx-star" style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.r * 2, height: s.r * 2, animationDelay: `${s.d}s` }} />
          ))}
        </div>
        {/* horizon glow */}
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-amber-500/25 to-transparent tx-glow" aria-hidden="true" />
        <Skyline />

        <header className="relative tx-rise">
          {/* transparent logo; the light variant has the navy lettering turned white so it reads on the night sky */}
          <img src="/twisha-pos-logo-light.png" alt={PRODUCT_NAME} className="h-16 w-auto drop-shadow-[0_6px_24px_rgba(56,189,248,0.35)]" width={243} height={64} />
        </header>

        <div className="relative mt-10 [@media(max-height:760px)]:mt-5 max-w-xl">
          <p className="tx-rise text-amber-300/90 text-sm font-semibold tracking-[0.2em] uppercase" style={{ animationDelay: '.05s' }}>Fleet & freight billing · Transporters</p>
          <h1 className="tx-rise tx-title mt-3 text-5xl xl:text-6xl [@media(max-height:760px)]:text-4xl xl:[@media(max-height:760px)]:text-5xl font-extrabold leading-[1.05] tracking-tight" style={{ animationDelay: '.12s' }}>
            Every load.<br />Every trip.<br />Every rupee.
          </h1>
          <p className="tx-rise mt-5 [@media(max-height:760px)]:mt-3 text-lg [@media(max-height:760px)]:text-base text-white/75 max-w-sm" style={{ animationDelay: '.2s' }}>
            Book the LR, run the trip, collect the POD, send the GST bill — and know what each truck really earned.
          </p>
        </div>

        {/* the route, with a callout at each stop — fills the lower part of the hero */}
        <div className="relative flex-1 min-h-0">
          <div className="absolute bottom-24 left-6 right-14" style={{ aspectRatio: `${VB.w} / ${VB.h}` }}>
            <RouteArt className="absolute inset-0 w-full h-full" />
            {STOPS.map((s) => <Callout key={s.name} s={s} />)}
          </div>
        </div>

        <Ticker />
      </aside>

      {/* ══ Sign in ════════════════════════════════════════════════════════════════ */}
      <main className="relative overflow-hidden flex flex-col px-5 py-8 lg:px-10 lg:rounded-l-[2.5rem] lg:-ml-8 z-10 shadow-[-24px_0_60px_rgba(0,0,0,0.25)]"
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

        {/* desktop top bar */}
        <div className="relative hidden lg:flex items-center justify-between">
          <span className="inline-flex items-center gap-2 text-xs text-slate-500">
            <span className="w-2 h-2 rounded-full bg-emerald-400" /> Secure sign-in
          </span>
          <Link to="/register" className="inline-flex items-center gap-1.5 rounded-full bg-white/80 ring-1 ring-slate-200 hover:ring-amber-300 px-4 py-1.5 text-sm text-slate-600 hover:text-slate-900 transition">
            New business? <span className="font-semibold text-slate-900">Create account</span> <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

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

              {/* who is signing in */}
              <div className="relative mt-6 grid grid-cols-2 p-1 rounded-xl bg-slate-100" role="group" aria-label="Who is signing in">
                <span className="absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-lg bg-white shadow-sm ring-1 ring-slate-200 transition-transform duration-300"
                  style={{ transform: isStaff ? 'translateX(100%)' : 'none' }} aria-hidden="true" />
                <button type="button" onClick={() => setIsStaff(false)} aria-pressed={!isStaff}
                  className={`relative z-10 flex items-center justify-center gap-2 h-9 text-sm font-semibold rounded-lg transition-colors ${!isStaff ? 'text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
                  <TruckIcon className="w-4 h-4" /> Owner
                </button>
                <button type="button" onClick={() => setIsStaff(true)} aria-pressed={isStaff}
                  className={`relative z-10 flex items-center justify-center gap-2 h-9 text-sm font-semibold rounded-lg transition-colors ${isStaff ? 'text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
                  <Users className="w-4 h-4" /> Staff member
                </button>
              </div>

              <form onSubmit={(e) => { e.preventDefault(); submit() }} className="mt-5 space-y-5">
                <div>
                  <label className="label" htmlFor="login-phone">{isStaff ? 'Your phone number' : 'Phone number'}</label>
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

                {isStaff && (
                  <div className="tx-rise">
                    <label className="label" htmlFor="login-biz">Business phone <span className="text-slate-400 font-normal">(the owner's number)</span></label>
                    <input
                      id="login-biz" type="tel" inputMode="numeric" maxLength={10} placeholder="Owner's phone"
                      value={bizPhone} onChange={(e) => setBizPhone(e.target.value.replace(/\D/g, ''))}
                      className="w-full h-12 px-3.5 rounded-xl border border-slate-300 bg-white text-base
                                 focus:border-amber-400 focus:ring-4 focus:ring-amber-100 outline-none transition"
                    />
                  </div>
                )}

                <div>
                  <div className="flex items-baseline justify-between">
                    <label className="label" htmlFor="login-pin">4-digit PIN</label>
                    <span className="text-[11px] text-slate-400">signs in automatically</span>
                  </div>
                  <PinBoxes value={pin} onChange={setPin} onComplete={(p) => { if (phone.length >= 10 && (!isStaff || bizPhone.length >= 10) && !loginMutation.isPending) loginMutation.mutate(p) }} />
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

            <div className="lg:hidden px-7 sm:px-8 py-4 bg-slate-50/80 border-t border-slate-200/70 text-center text-sm text-slate-500">
              New business?{' '}
              <Link to="/register" className="font-semibold text-slate-900 underline decoration-amber-400 decoration-2 underline-offset-4 hover:decoration-amber-500">Create your account</Link>
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

        <div className="relative hidden lg:flex [@media(max-height:760px)]:hidden items-center justify-between text-[11px] text-slate-400">
          <span>© {new Date().getFullYear()} {PRODUCT_NAME}</span>
          <span>Made in India</span>
        </div>
      </main>
    </div>
  )
}
