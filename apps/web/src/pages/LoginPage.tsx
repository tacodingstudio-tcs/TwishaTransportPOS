// src/pages/LoginPage.tsx
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { authApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Truck, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth  = useAuthStore((s) => s.setAuth)
  const [phone, setPhone] = useState('')
  const [pin, setPin]     = useState('')
  const [bizPhone, setBizPhone] = useState('')
  const [isStaff, setIsStaff]   = useState(false)

  const loginMutation = useMutation({
    mutationFn: () => authApi.login(phone, pin, isStaff ? bizPhone : undefined),
    onSuccess: (data) => {
      setAuth(
        data.accessToken, data.refreshToken, data.accessTokenExpiresIn,
        data.user, data.tenant, data.branch
      )
      toast.success(`Welcome back, ${data.user.name}!`)
      navigate('/')
    },
    onError: () => {
      toast.error('Invalid phone number or PIN')
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (phone.length < 10 || pin.length !== 4 || (isStaff && bizPhone.length < 10)) return
    loginMutation.mutate()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 to-gray-50 px-4">
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-primary-600 flex items-center justify-center mb-4 shadow-lg shadow-primary-600/20">
            <Truck className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Welcome back</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in to your transport dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="card p-6 space-y-4">
          <div>
            <label className="label">Phone number</label>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={10}
              placeholder="9876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
              className="input"
              autoFocus
            />
          </div>

          {isStaff && (
            <div>
              <label className="label">Business phone <span className="text-gray-400 font-normal">(the owner's number)</span></label>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="Owner's registered phone"
                value={bizPhone}
                onChange={(e) => setBizPhone(e.target.value.replace(/D/g, ''))}
                className="input"
              />
            </div>
          )}

          <div>
            <label className="label">4-digit PIN</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              placeholder="••••"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              className="input text-center text-2xl tracking-[0.5em] font-semibold"
            />
          </div>

          <button
            type="submit"
            disabled={phone.length < 10 || pin.length !== 4 || (isStaff && bizPhone.length < 10) || loginMutation.isPending}
            className="btn-primary w-full justify-center mt-2"
          >
            {loginMutation.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : 'Sign in'}
          </button>
          <button type="button" onClick={() => setIsStaff((v) => !v)}
            className="block mx-auto text-xs text-gray-500 hover:text-primary-600">
            {isStaff ? 'I am the owner' : 'Staff member? Sign in with the business phone'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-4">
          New business?{' '}
          <Link to="/register" className="text-primary-600 font-medium hover:underline">
            Create account
          </Link>
        </p>

        {import.meta.env.DEV && (
          <details className="mt-4">
            <summary className="text-center text-xs text-gray-400 cursor-pointer select-none">
              Demo accounts (dev only) ▾
            </summary>
            <div className="mt-2 text-xs text-gray-500 bg-gray-50 rounded-lg p-3 space-y-1">
              {[
                ['Owner — Shree Ganesh Roadlines', '9100000001', '1111'],
                ['Manager', '9100000011', '2222'],
                ['Viewer (read-only)', '9100000012', '3333'],
              ].map(([who, phone, pin]) => (
                <div
                  key={phone}
                  className="flex justify-between gap-2 cursor-pointer hover:text-primary-600 py-0.5"
                  onClick={() => { setPhone(phone ?? ''); setPin(pin ?? ''); setIsStaff(phone !== '9100000001'); setBizPhone(phone !== '9100000001' ? '9100000001' : '') }}
                >
                  <span className="font-medium">{who}</span>
                  <span>{phone}</span>
                  <span className="font-mono">{pin}</span>
                </div>
              ))}
              <p className="text-gray-400 pt-1">Click a row to fill the form. Run <code>pnpm --filter @billing/api seed</code> to create them.</p>
            </div>
          </details>
        )}
      </div>
    </div>
  )
}
