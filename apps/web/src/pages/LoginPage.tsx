// src/pages/LoginPage.tsx
// Twisha Transport POS sign-in. Left: a dark hero — a truck driving a route between cities, plus the two things the
// product is about (a trip's real profit after diesel and toll, and the LR → POD → freight-bill chain). Right: a
// calm sign-in card with a 4-box PIN.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Loader2, Route, Fuel, FileText, Phone, ArrowRight, Check } from 'lucide-react'
import toast from 'react-hot-toast'
import { PoweredBy } from '@/components/PoweredBy'
import { PRODUCT_NAME } from '@/lib/branding'

const CSS = `
@keyframes tx-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-9px) } }
@keyframes tx-rise  { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: none } }
@keyframes tx-glow  { 0%,100% { opacity: .5 } 50% { opacity: .85 } }
@keyframes tx-sweep { from { background-position: -200% 0 } to { background-position: 200% 0 } }
@keyframes tx-dash  { to { stroke-dashoffset: -40 } }
.tx-float { animation: tx-float 6s ease-in-out infinite }
.tx-rise  { animation: tx-rise .7s cubic-bezier(.2,.7,.2,1) both }
.tx-glow  { animation: tx-glow 5s ease-in-out infinite }
.tx-dash  { animation: tx-dash 2.4s linear infinite }
.tx-title { background: linear-gradient(100deg,#fff 20%,#fcd34d 45%,#fff 70%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: tx-sweep 7s linear infinite }
@media (prefers-reduced-motion: reduce) { .tx-float,.tx-rise,.tx-glow,.tx-dash,.tx-title { animation: none } }
`

const ROUTE = 'M30,310 C130,310 150,190 270,205 S430,130 500,62'

/** A route between cities with a truck driving along it. Pure SVG; the truck stands still for reduced-motion users. */
function RouteArt({ className = '' }: { className?: string }) {
  const still = useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, [])
  const city = (x: number, y: number, name: string, dy = -14) => (
    <g>
      <circle cx={x} cy={y} r="11" fill="#fbbf24" fillOpacity="0.18" />
      <circle cx={x} cy={y} r="5.5" fill="#fbbf24" stroke="#fff7ed" strokeWidth="2" />
      <text x={x} y={y + dy} textAnchor="middle" fontSize="12" fontWeight="700" fill="#fde68a" letterSpacing="1.5">{name}</text>
    </g>
  )
  return (
    <svg viewBox="0 0 540 360" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="tx-road" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#f59e0b" stopOpacity="0.2" /><stop offset="1" stopColor="#fbbf24" stopOpacity="0.9" />
        </linearGradient>
        <path id="tx-route" d={ROUTE} />
      </defs>
      {/* road: wide dark band, a bright edge, and moving centre dashes */}
      <use href="#tx-route" fill="none" stroke="#0b1220" strokeWidth="30" strokeLinecap="round" />
      <use href="#tx-route" fill="none" stroke="#1e293b" strokeWidth="26" strokeLinecap="round" />
      <use href="#tx-route" fill="none" stroke="url(#tx-road)" strokeWidth="2" strokeLinecap="round" transform="translate(0 -13)" opacity="0.5" />
      <use href="#tx-route" fill="none" stroke="#fde68a" strokeWidth="2.5" strokeDasharray="14 14" strokeLinecap="round" className="tx-dash" />
      {city(30, 310, 'SURAT', 30)}
      {city(270, 205, 'AHMEDABAD', 30)}
      {city(500, 62, 'JAIPUR', -18)}
      {/* the truck: trailer, cab, wheels — drawn facing +x and steered by the path */}
      <g>
        {!still && <animateMotion dur="14s" repeatCount="indefinite" rotate="auto" keyPoints="0;1" keyTimes="0;1" calcMode="linear"><mpath href="#tx-route" /></animateMotion>}
        <g transform={still ? 'translate(270 205)' : undefined}>
          <rect x="-30" y="-17" width="38" height="22" rx="3" fill="#f8fafc" stroke="#94a3b8" strokeWidth="1" />
          <rect x="-26" y="-12" width="30" height="3" rx="1.5" fill="#f59e0b" />
          <rect x="-26" y="-6" width="20" height="3" rx="1.5" fill="#cbd5e1" />
          <path d="M10,-11 h10 l7,8 v8 h-17 z" fill="#f59e0b" stroke="#b45309" strokeWidth="1" />
          <path d="M13,-8 h5 l4,5 h-9 z" fill="#bae6fd" />
          {[-20, -9, 18].map((x) => <circle key={x} cx={x} cy="7" r="4.6" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1.5" />)}
        </g>
      </g>
    </svg>
  )
}

/** The headline number: what one trip actually earned after diesel (even when it's still unpaid) and toll. */
function TripCard({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  const row = (k: string, v: string, tone = 'text-white/65') => (
    <div className={`flex justify-between text-xs ${tone}`}><span>{k}</span><span className="tabular-nums">{v}</span></div>
  )
  return (
    <div className={`rounded-2xl p-4 w-72 bg-slate-950/55 backdrop-blur-lg ring-1 ring-white/20 shadow-2xl shadow-black/40 ${className}`} style={style}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-white/50">Trip · GJ 05 AB 1234</div>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-400/20 text-amber-300">Surat → Jaipur</span>
      </div>
      <div className="mt-3 space-y-1.5">
        {row('Freight (bhada)', '₹48,000')}
        {row('Diesel · Sharma Pump, on account', '− ₹14,200', 'text-amber-200/90')}
        {row('Toll & driver bhatta', '− ₹3,150')}
      </div>
      <div className="mt-2 pt-2 border-t border-white/15 flex items-end justify-between">
        <span className="text-[13px] font-semibold text-white">Profit on this trip</span>
        <span className="text-xl font-bold text-emerald-300 tabular-nums">₹30,650</span>
      </div>
      <div className="text-[11px] text-white/45 mt-0.5 text-right">64% margin · ₹14,200 still owed to the pump</div>
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
          className="w-full h-14 text-center text-2xl font-bold rounded-xl border border-gray-300 bg-white
                     focus:border-primary-500 focus:ring-4 focus:ring-primary-100 outline-none transition
                     data-[filled=true]:border-primary-400 data-[filled=true]:bg-primary-50/40"
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
      <aside className="hidden lg:flex relative overflow-hidden flex-col justify-between p-12 text-white"
        style={{ background: 'radial-gradient(1100px 700px at 15% 0%, #1e3a5f 0%, #0f1f3a 38%, #070d1a 75%)' }}>
        {/* dot grid + glow */}
        <div className="absolute inset-0 opacity-[0.14]" style={{ backgroundImage: 'radial-gradient(#fcd34d 1px, transparent 1px)', backgroundSize: '26px 26px' }} aria-hidden="true" />
        <div className="absolute -right-24 top-1/4 w-[34rem] h-[34rem] rounded-full bg-amber-400/15 blur-3xl tx-glow" aria-hidden="true" />

        {/* the route, bottom-right */}
        <div className="absolute right-14 bottom-20 w-[34rem] max-w-[58%]" aria-hidden="true">
          <RouteArt className="w-full h-auto drop-shadow-[0_30px_50px_rgba(0,0,0,0.5)]" />
        </div>

        <header className="relative tx-rise">
          <div className="inline-flex items-center gap-3">
            <span className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-300 to-amber-500 text-slate-900 flex items-center justify-center font-extrabold text-xl shadow-lg shadow-amber-500/30">T</span>
            <span className="text-lg font-semibold tracking-tight">{PRODUCT_NAME}</span>
          </div>
        </header>

        <div className="relative max-w-xl">
          <p className="tx-rise text-amber-300/90 text-sm font-semibold tracking-[0.2em] uppercase" style={{ animationDelay: '.05s' }}>Fleet & freight billing · Transporters</p>
          <h1 className="tx-rise tx-title mt-4 text-5xl xl:text-6xl [@media(max-height:760px)]:text-4xl xl:[@media(max-height:760px)]:text-5xl font-extrabold leading-[1.05] tracking-tight" style={{ animationDelay: '.12s' }}>
            Every load.<br />Every trip.<br />Every rupee.
          </h1>
          <p className="tx-rise mt-6 [@media(max-height:760px)]:mt-4 text-lg [@media(max-height:760px)]:text-base text-white/70 max-w-sm" style={{ animationDelay: '.2s' }}>
            Book the LR, run the trip, collect the POD, send the GST freight bill — and know what each truck really earned after diesel and toll.
          </p>

          <div className="tx-rise mt-9 [@media(max-height:760px)]:mt-5 flex flex-wrap gap-2.5 max-w-sm" style={{ animationDelay: '.3s' }}>
            {[
              [Route, 'LR → Trip → POD → Bill'],
              [Fuel, 'Diesel on account, tracked'],
              [FileText, 'GST freight bills, TDS'],
            ].map(([Icon, text]) => {
              const I = Icon as React.ElementType
              return (
                <span key={text as string} className="inline-flex items-center gap-2 rounded-full bg-white/[0.07] ring-1 ring-white/15 backdrop-blur px-3.5 py-1.5 text-sm text-white/85">
                  <I className="w-4 h-4 text-amber-300" /> {text as string}
                </span>
              )
            })}
          </div>
        </div>

        {/* floating cards, above the route */}
        <div className="absolute right-10 top-16 tx-rise hidden min-[1400px]:flex flex-col items-end gap-3" style={{ animationDelay: '.45s' }}>
          <TripCard className="tx-float" />
          <div className="tx-float w-72 [@media(max-height:780px)]:hidden rounded-xl bg-slate-950/60 backdrop-blur-lg ring-1 ring-white/20 px-4 py-3 shadow-xl shadow-black/40"
            style={{ animationDelay: '-2.5s' }}>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/55">
              <Check className="w-3.5 h-3.5 text-emerald-300" /> POD received
            </div>
            <div className="mt-1 font-semibold text-white text-sm">LR 1187 · Arvind Textiles</div>
            <div className="text-xs text-amber-300 mt-0.5">Ready to add to this month’s freight bill</div>
          </div>
        </div>

        <footer className="relative text-xs text-white/55 tx-rise" style={{ animationDelay: '.7s' }}>
          Powered by{' '}
          <a href="https://www.twishaconsultancyservices.com/" target="_blank" rel="noopener noreferrer"
            className="font-semibold text-white/90 hover:text-white hover:underline">Twisha Consultancy Services</a>
        </footer>
      </aside>

      {/* ══ Sign in ════════════════════════════════════════════════════════════════ */}
      <main className="relative flex items-center justify-center px-5 py-10 bg-white lg:rounded-l-[2.5rem] lg:-ml-8 z-10 shadow-[-24px_0_60px_rgba(0,0,0,0.25)]">
        <div className="w-full max-w-sm tx-rise">

          {/* small screens: compact brand */}
          <div className="lg:hidden text-center mb-8">
            <span className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-amber-300 to-amber-500 text-slate-900 flex items-center justify-center font-extrabold text-2xl shadow-lg shadow-amber-500/30">T</span>
            <div className="mt-3 text-2xl font-extrabold text-gray-900">{PRODUCT_NAME}</div>
            <div className="text-xs text-gray-500">Every load. Every trip. Every rupee.</div>
          </div>

          <p className="text-sm font-semibold text-primary-600">{greeting} 👋</p>
          <h2 className="mt-1 text-3xl font-extrabold text-gray-900 tracking-tight">Welcome back</h2>
          <p className="text-sm text-gray-500 mt-2">
            {isStaff ? 'Staff sign-in — add the business’s registered number too.' : `Sign in to ${PRODUCT_NAME} with your phone number and 4-digit PIN.`}
          </p>

          <form onSubmit={(e) => { e.preventDefault(); submit() }} className="mt-7 space-y-5">
            <div>
              <label className="label" htmlFor="login-phone">Phone number</label>
              <div className="relative">
                <Phone className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <span className="absolute left-10 top-1/2 -translate-y-1/2 text-sm text-gray-400 select-none">+91</span>
                <input
                  id="login-phone" type="tel" inputMode="numeric" maxLength={10} placeholder="98765 43210" autoFocus
                  value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  className="w-full h-12 pl-[4.6rem] pr-3 rounded-xl border border-gray-300 bg-white text-base
                             focus:border-primary-500 focus:ring-4 focus:ring-primary-100 outline-none transition"
                />
              </div>
            </div>

            {isStaff && (
              <div className="tx-rise">
                <label className="label" htmlFor="login-biz">Business phone <span className="text-gray-400 font-normal">(the owner's number)</span></label>
                <input
                  id="login-biz" type="tel" inputMode="numeric" maxLength={10} placeholder="Owner's phone"
                  value={bizPhone} onChange={(e) => setBizPhone(e.target.value.replace(/\D/g, ''))}
                  className="w-full h-12 px-3.5 rounded-xl border border-gray-300 bg-white text-base
                             focus:border-primary-500 focus:ring-4 focus:ring-primary-100 outline-none transition"
                />
              </div>
            )}

            <div>
              <label className="label" htmlFor="login-pin">PIN</label>
              <PinBoxes value={pin} onChange={setPin} onComplete={(p) => { if (phone.length >= 10 && (!isStaff || bizPhone.length >= 10) && !loginMutation.isPending) loginMutation.mutate(p) }} />
            </div>

            <button type="submit" disabled={!ready || loginMutation.isPending}
              className="group w-full h-12 rounded-xl font-semibold text-white flex items-center justify-center gap-2
                         bg-gradient-to-r from-primary-600 to-emerald-600 shadow-lg shadow-primary-600/25
                         hover:shadow-xl hover:shadow-primary-600/35 hover:-translate-y-px active:translate-y-0
                         disabled:opacity-50 disabled:shadow-none disabled:hover:translate-y-0 transition-all">
              {loginMutation.isPending
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing you in…</>
                : <>Sign in <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" /></>}
            </button>
            {waking && (
              <p role="status" className="text-center text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                The server was asleep and is waking up — this takes up to a minute. Please wait, you will be signed in automatically.
              </p>
            )}

            <button type="button" onClick={() => setIsStaff((v) => !v)}
              className="block mx-auto text-xs text-gray-500 hover:text-primary-600">
              {isStaff ? 'I am the owner' : 'Staff member? Sign in with the business phone'}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-gray-200/80 text-center text-sm text-gray-500">
            New business?{' '}
            <Link to="/register" className="text-primary-600 font-semibold hover:underline">Create your {PRODUCT_NAME} account</Link>
          </div>

          <PoweredBy className="text-center mt-6 lg:hidden" />
        </div>
      </main>
    </div>
  )
}
