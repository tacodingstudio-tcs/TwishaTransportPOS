// src/pages/BranchesPage.tsx
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { transportApi, apiError } from '@/lib/api'
import { useFirms, KIND_LABEL, FIRM_TONES, type Firm, type FirmKind } from '@/hooks/useFirms'
import { FirmAvatar } from '@/components/layout/FirmSwitcher'
import { logoToDataUrl } from '@/lib/imageUtils'
import {
  useBranches, useUpdateBranch,
  useUsers, useCreateUser, useResetUserPin, useDeactivateUser, useActivateUser,
} from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  Plus, Building2, MapPin, FileText, Users, KeyRound, UserX, UserCheck, ArrowLeft, Truck, Pencil, Upload, Package, Check,
} from 'lucide-react'

// Role display names — underlying values stay 'manager' / 'cashier' / 'viewer'
// so permissions don't change, only the label matches a transport business.
const DOMAIN_ROLE_NAMES: Record<string, { manager: string; cashier: string; viewer: string }> = {
  transport: { manager: 'Operations Manager', cashier: 'Booking Clerk / Accounts', viewer: 'Viewer (read-only)' },
}

const DEFAULT_ROLE_NAMES = { manager: 'Manager', cashier: 'Cashier / Staff', viewer: 'Viewer' }

function getRoleNames(domainType?: string) {
  return DOMAIN_ROLE_NAMES[domainType ?? ''] ?? DEFAULT_ROLE_NAMES
}

const ROLE_COLORS: Record<string, string> = {
  owner:   'bg-purple-100 text-purple-700',
  manager: 'bg-blue-100 text-blue-700',
  cashier: 'bg-green-100 text-green-700',
  viewer:  'bg-gray-100 text-gray-600',
}

// ── Business profile editor ───────────────────────────────────────────────────

const GST_MODE_OPTIONS: Array<[string, string]> = [
  ['rcm', 'RCM — recipient pays GST (GTA 5%)'],
  ['forward_5', 'Forward charge 5% (no ITC)'],
  ['forward_12', 'Forward charge 12% (with ITC)'],
  ['forward_18', 'Forward charge 18% (with ITC)'],
  ['exempt', 'Exempt'],
]

function BusinessModal({ branch, onClose }: { branch: any; onClose: () => void }) {
  const updateBranch = useUpdateBranch()
  const qc = useQueryClient()
  const cfg = (branch.domainConfig ?? {}) as Record<string, any>
  const kind: FirmKind = branch.kind === 'goods' ? 'goods' : 'transport'

  // bill numbers: either the standard financial-year series, or the firm's own running series (F-4, F-5 …)
  const [numOn, setNumOn] = useState(branch.numbering?.style === 'plain')
  const [numPrefix, setNumPrefix] = useState(String(branch.numbering?.prefix ?? ''))
  const [numNext, setNumNext] = useState(String(branch.numbering?.next ?? 1))
  const [logo, setLogo] = useState<string | null>(branch.logo ?? null)
  const [logoBusy, setLogoBusy] = useState(false)

  async function pickLogo(file: File | undefined) {
    if (!file) return
    setLogoBusy(true)
    try {
      const url = await logoToDataUrl(file)
      await transportApi.setLogo(branch.id, url)
      setLogo(url)
      qc.invalidateQueries({ queryKey: ['firms'] })
      toast.success('Logo saved')
    } catch (e) { toast.error(e instanceof Error && !('response' in e) ? e.message : apiError(e)) }
    finally { setLogoBusy(false) }
  }
  async function removeLogo() {
    setLogoBusy(true)
    try { await transportApi.setLogo(branch.id, null); setLogo(null); qc.invalidateQueries({ queryKey: ['firms'] }) }
    catch (e) { toast.error(apiError(e)) }
    finally { setLogoBusy(false) }
  }

  const [form, setForm] = useState({
    name:      branch.name ?? '',
    gstin:     branch.gstin ?? '',
    stateCode: branch.stateCode ?? '',
    line1:     branch.address?.line1 ?? '',
    city:      branch.address?.city ?? '',
    pincode:   branch.address?.pincode ?? '',
    lrPrefix:  String(cfg['lr_prefix'] ?? 'LR'),
    gstMode:   String(cfg['default_gst_mode'] ?? 'rcm'),
    sac:       String(cfg['default_sac_code'] ?? '996791'),
    ewayLimit: String(cfg['eway_threshold'] ?? 50000),
    alertDays: String(cfg['compliance_alert_days'] ?? 30),
    podFirst:  Boolean(cfg['pod_required_before_billing']),
    pan:       String(cfg['pan'] ?? ''),
    bankName:  String(cfg['bank_name'] ?? ''),
    bankAcc:   String(cfg['bank_account_no'] ?? ''),
    bankIfsc:  String(cfg['bank_ifsc'] ?? ''),
    declaration: String(cfg['gta_declaration'] ?? ''),
    terms:     String(cfg['bill_terms'] ?? ''),
  })
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value })

  async function handleSubmit() {
    if (form.name.trim().length < 2) return
    await updateBranch.mutateAsync({
      id: branch.id,
      name: form.name.trim(),
      gstin: form.gstin || null,
      stateCode: form.stateCode || null,
      address: { ...(branch.address ?? {}), line1: form.line1 || undefined, city: form.city || undefined, pincode: form.pincode || undefined },
      domainConfig: {
        // trucks, LRs and e-way bills only exist for a transport firm
        ...(kind === 'transport' ? {
          lr_prefix: form.lrPrefix.trim().toUpperCase() || 'LR',
          default_gst_mode: form.gstMode,
          default_sac_code: form.sac.trim() || '996791',
          eway_threshold: Number(form.ewayLimit) || 50000,
          compliance_alert_days: Number(form.alertDays) || 30,
          pod_required_before_billing: form.podFirst,
          gta_declaration: form.declaration.trim(),
        } : {}),
        pan: form.pan.trim().toUpperCase(),
        bank_name: form.bankName.trim(), bank_account_no: form.bankAcc.trim(), bank_ifsc: form.bankIfsc.trim().toUpperCase(),
        bill_terms: form.terms.trim(),
      },
    })
    if (numOn) {
      const next = Number(numNext)
      const same = branch.numbering?.style === 'plain' && branch.numbering.prefix === numPrefix && branch.numbering.next === next
      if (!same) {
        try { await transportApi.setNumbering(branch.id, { prefix: numPrefix, next }) }
        catch { return }                     // the server's message is already on screen; keep the form open
        qc.invalidateQueries({ queryKey: ['firms'] })
      }
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-xl max-h-[92vh] overflow-y-auto p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-1">Edit firm</h3>
        <p className="text-xs text-gray-500 mb-5">{KIND_LABEL[kind]} firm</p>

        <div className="space-y-4">
          <div>
            <label className="label">Firm name *</label>
            <input className="input" value={form.name} onChange={set('name')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="label">GSTIN</label>
              <input className="input" placeholder="24AAAAA0000A1Z5" maxLength={15} value={form.gstin}
                onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
            </div>
            <div>
              <label className="label">State code</label>
              <input className="input" placeholder="24" maxLength={2} value={form.stateCode}
                onChange={(e) => setForm({ ...form, stateCode: e.target.value.replace(/\D/g, '') })} />
            </div>
          </div>
          <div>
            <label className="label">Address</label>
            <input className="input" placeholder="Office / yard address" value={form.line1} onChange={set('line1')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">City</label><input className="input" value={form.city} onChange={set('city')} /></div>
            <div><label className="label">Pincode</label><input className="input" value={form.pincode} onChange={set('pincode')} /></div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Logo on your bills</h4>
            <div className="flex items-center gap-4">
              <div className="w-32 h-16 border border-dashed border-gray-300 rounded-lg bg-gray-50 flex items-center justify-center overflow-hidden">
                {logo ? <img src={logo} alt="Logo" className="max-w-full max-h-full object-contain" /> : <span className="text-xs text-gray-400">No logo yet</span>}
              </div>
              <div className="flex items-center gap-2">
                <label className={`btn-ghost text-sm cursor-pointer ${logoBusy ? 'opacity-50 pointer-events-none' : ''}`}>
                  <Upload className="w-4 h-4" /> {logo ? 'Change logo' : 'Upload logo'}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = '' }} />
                </label>
                {logo && <button type="button" className="btn-ghost text-sm text-red-600" disabled={logoBusy} onClick={removeLogo}>Remove</button>}
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-2">Printed at the top-left of every bill. A PNG with a transparent background looks best.</p>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Bill numbers</h4>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={numOn} onChange={(e) => setNumOn(e.target.checked)} />
              Use my own running numbers (like F-4, F-5, F-6…)
            </label>
            {numOn ? (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <label className="label">Starts with</label>
                  <input className="input" maxLength={12} placeholder="F-  (or leave empty)" value={numPrefix} onChange={(e) => setNumPrefix(e.target.value)} />
                </div>
                <div>
                  <label className="label">Next bill number</label>
                  <input type="number" min="1" className="input" value={numNext} onChange={(e) => setNumNext(e.target.value)} />
                </div>
                <p className="col-span-2 text-xs text-gray-500">The next bill will be <strong>{numPrefix}{Number(numNext) || 1}</strong>, then {numPrefix}{(Number(numNext) || 1) + 1}… It never restarts by itself.</p>
              </div>
            ) : (
              <p className="text-xs text-gray-400 mt-2">Standard numbers like ABC-2627-00001, restarting each April.</p>
            )}
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Printed on your bills</h4>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">PAN</label><input className="input" maxLength={10} placeholder="AAAAA9999A" value={form.pan} onChange={set('pan')} /></div>
              <div><label className="label">Bank name</label><input className="input" value={form.bankName} onChange={set('bankName')} /></div>
              <div><label className="label">Account no</label><input className="input" value={form.bankAcc} onChange={set('bankAcc')} /></div>
              <div><label className="label">IFSC</label><input className="input" maxLength={11} value={form.bankIfsc} onChange={set('bankIfsc')} /></div>
              {kind === 'transport' && (
                <div className="col-span-2">
                  <label className="label">GTA declaration <span className="text-gray-400 font-normal">(blank = standard wording for the GST treatment used)</span></label>
                  <textarea className="input h-16 resize-none" value={form.declaration} onChange={(e) => setForm({ ...form, declaration: e.target.value })} />
                </div>
              )}
              <div className="col-span-2">
                <label className="label">Terms &amp; conditions <span className="text-gray-400 font-normal">(one per line)</span></label>
                <textarea className="input h-20 resize-none" value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
              </div>
            </div>
          </div>

          {kind === 'transport' && <div className="border-t border-gray-100 pt-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Settings</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">LR number starts with</label>
                <input className="input" maxLength={6} value={form.lrPrefix} onChange={set('lrPrefix')} />
                <p className="text-xs text-gray-400 mt-1">e.g. LR → LR-2627-0001 (restarts each April)</p>
              </div>
              <div>
                <label className="label">Default SAC code</label>
                <input className="input" maxLength={8} value={form.sac} onChange={set('sac')} />
              </div>
              <div className="col-span-2">
                <label className="label">How do you usually charge GST?</label>
                <select className="input" value={form.gstMode} onChange={set('gstMode')}>
                  {GST_MODE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="label">E-way bill needed above (₹)</label>
                <input type="number" min="0" className="input" value={form.ewayLimit} onChange={set('ewayLimit')} />
              </div>
              <div>
                <label className="label">Warn me before papers end (days)</label>
                <input type="number" min="1" max="365" className="input" value={form.alertDays} onChange={set('alertDays')} />
              </div>
              <label className="col-span-2 flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={form.podFirst} onChange={(e) => setForm({ ...form, podFirst: e.target.checked })} />
                Do not allow bill until signed LR copy is back
              </label>
            </div>
          </div>}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={updateBranch.isPending || form.name.trim().length < 2} className="btn-primary">
            {updateBranch.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Add firm modal ────────────────────────────────────────────────────────────

function AddFirmModal({ firms, currentFirmId, onClose, onAdded }: { firms: Firm[]; currentFirmId?: string; onClose: () => void; onAdded: (f: Firm) => void }) {
  const qc = useQueryClient()
  const base = firms.find((f) => f.id === currentFirmId) ?? firms[0]
  const [f, setF] = useState({ name: '', kind: 'goods' as FirmKind, gstin: base?.gstin ?? '', stateCode: base?.stateCode ?? '', line1: String(base?.address?.line1 ?? ''), city: String(base?.address?.city ?? ''), pincode: String(base?.address?.pincode ?? ''), copy: true })
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const created: Firm = await transportApi.addFirm({
        name: f.name.trim(), kind: f.kind, gstin: f.gstin.trim().toUpperCase() || null, stateCode: f.stateCode || null,
        address: { line1: f.line1.trim() || undefined, city: f.city.trim() || undefined, pincode: f.pincode.trim() || undefined },
        copySettingsFrom: f.copy && base ? base.id : undefined,
      })
      qc.invalidateQueries({ queryKey: ['firms'] }); qc.invalidateQueries({ queryKey: ['branches'] })
      toast.success(`${created.name} added`)
      onAdded(created)
    } catch (e) { toast.error(apiError(e)) }
    finally { setBusy(false) }
  }

  const kinds: Array<[FirmKind, string, string, React.ElementType]> = [
    ['transport', 'Transport', 'Trucks, trips, loads (LR) and freight bills', Truck],
    ['goods', 'Goods / trading', 'Sells goods and makes goods bills', Package],
  ]
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-1">Add a firm</h3>
        <p className="text-xs text-gray-500 mb-5">Another business name you bill under. It gets its own bill numbers, customers and accounts — same login.</p>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {kinds.map(([k, title, sub, Icon]) => (
              <button key={k} type="button" onClick={() => setF({ ...f, kind: k })}
                className={`text-left rounded-lg border p-3 ${f.kind === k ? 'border-primary-500 ring-2 ring-primary-100 bg-primary-50/40' : 'border-gray-200 hover:bg-gray-50'}`}>
                <span className="flex items-center gap-2 text-sm font-semibold text-gray-900"><Icon className="w-4 h-4 text-gray-500" /> {title}{f.kind === k && <Check className="w-4 h-4 text-primary-600 ml-auto" />}</span>
                <span className="block text-xs text-gray-500 mt-1">{sub}</span>
              </button>
            ))}
          </div>
          <div><label className="label">Firm name *</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2"><label className="label">GSTIN</label><input className="input" maxLength={15} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} /></div>
            <div><label className="label">State code</label><input className="input" maxLength={2} value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value.replace(/\D/g, '') })} /></div>
          </div>
          <div><label className="label">Address</label><input className="input" value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">City</label><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></div>
            <div><label className="label">Pincode</label><input className="input" value={f.pincode} onChange={(e) => setF({ ...f, pincode: e.target.value })} /></div>
          </div>
          {base && (
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input type="checkbox" className="mt-0.5" checked={f.copy} onChange={(e) => setF({ ...f, copy: e.target.checked })} />
              <span>Start with {base.name}’s PAN, bank details and bill terms<span className="block text-xs text-gray-400">You can change them afterwards. The logo and bill numbers are never copied.</span></span>
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="button" onClick={save} disabled={busy || f.name.trim().length < 2} className="btn-primary">{busy ? 'Adding…' : 'Add firm'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Add user modal ────────────────────────────────────────────────────────────

function AddUserModal({ branches, domainType, onClose }: { branches: any[]; domainType?: string; onClose: () => void }) {
  const rn = getRoleNames(domainType)
  const createUser = useCreateUser()
  const [form, setForm] = useState({
    name:      '',
    phone:     '',
    pin:       '',
    role:      'cashier',
    branchIds: [] as string[],
    lang:      'hi',
  })

  function toggleBranch(id: string) {
    setForm((f) => ({
      ...f,
      branchIds: f.branchIds.includes(id)
        ? f.branchIds.filter((b) => b !== id)
        : [...f.branchIds, id],
    }))
  }

  async function handleSubmit() {
    if (!form.name.trim() || form.phone.length < 10 || form.pin.length !== 4) return
    await createUser.mutateAsync({
      name:      form.name.trim(),
      phone:     form.phone.trim(),
      pin:       form.pin,
      role:      form.role,
      branchIds: form.branchIds,
      lang:      form.lang,
    })
    onClose()
  }

  const canSubmit = form.name.trim() && form.phone.length >= 10 && form.pin.length === 4 && !createUser.isPending

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-gray-900 mb-5">Add New User</h3>

        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="u-name">Full name *</label>
            <input id="u-name" className="input" placeholder="Ramesh Patel"
              value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>

          <div>
            <label className="label" htmlFor="u-phone">Phone number *</label>
            <input id="u-phone" type="tel" className="input" placeholder="9876543210"
              value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <p className="text-xs text-gray-400 mt-1">Used to log in to the app</p>
          </div>

          <div>
            <label className="label" htmlFor="u-pin">4-digit PIN *</label>
            <input id="u-pin" type="password" className="input" placeholder="••••"
              maxLength={4} value={form.pin}
              onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })} />
          </div>

          <div>
            <label className="label" htmlFor="u-role">Role *</label>
            <select id="u-role" className="input" value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="cashier">{rn.cashier} — create invoices, record payments</option>
              <option value="manager">{rn.manager} — full access except owner settings</option>
              <option value="viewer">{rn.viewer} — read-only access</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor="u-lang">Language</label>
            <select id="u-lang" className="input" value={form.lang}
              onChange={(e) => setForm({ ...form, lang: e.target.value })}>
              <option value="hi">Hindi</option>
              <option value="en">English</option>
              <option value="gu">Gujarati</option>
              <option value="mr">Marathi</option>
              <option value="ta">Tamil</option>
              <option value="te">Telugu</option>
              <option value="kn">Kannada</option>
              <option value="bn">Bengali</option>
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={!canSubmit} className="btn-primary">
            {createUser.isPending ? 'Creating…' : 'Create User'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Reset PIN modal ───────────────────────────────────────────────────────────

function ResetPinModal({ user, onClose }: { user: any; onClose: () => void }) {
  const resetPin = useResetUserPin()
  const [pin, setPin] = useState('')

  async function handleSubmit() {
    if (pin.length !== 4) return
    await resetPin.mutateAsync({ id: user.id, pin })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-1">Reset PIN</h3>
        <p className="text-sm text-gray-500 mb-4">Set a new 4-digit PIN for <strong>{user.name}</strong></p>

        <label className="label" htmlFor="new-pin">New PIN</label>
        <input id="new-pin" type="password" className="input mb-4" placeholder="••••"
          maxLength={4} value={pin} autoFocus
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="button" onClick={handleSubmit}
            disabled={pin.length !== 4 || resetPin.isPending} className="btn-primary">
            {resetPin.isPending ? 'Saving…' : 'Reset PIN'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Users panel ───────────────────────────────────────────────────────────────

function UsersPanel({ branches, domainType, onBack }: { branches: any[]; domainType?: string; onBack: () => void }) {
  const role = useAuthStore((s) => s.user?.role)
  const currentUserId = useAuthStore((s) => s.user?.id)
  const { data, isLoading } = useUsers()
  const deactivate = useDeactivateUser()
  const activate   = useActivateUser()
  const rn = getRoleNames(domainType)

  const [showAdd,     setShowAdd]     = useState(false)
  const [resetUser,   setResetUser]   = useState<any | null>(null)

  const users: any[] = data?.users ?? []

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button type="button" onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="w-4 h-4" /> Back to business
        </button>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Users & Staff</h2>
          <p className="text-xs text-gray-500 mt-0.5">{users.length} user{users.length !== 1 ? 's' : ''}</p>
        </div>
        {role === 'owner' && (
          <button type="button" onClick={() => setShowAdd(true)} className="btn-primary text-sm">
            <Plus className="w-4 h-4" /> Add User
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : users.length === 0 ? (
        <div className="card p-12 text-center">
          <Users className="w-10 h-10 mx-auto mb-3 text-gray-200" />
          <p className="text-gray-400 text-sm">No users yet. Add your first staff member.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => {
            const isSelf  = u.id === currentUserId
            const allBranches = !u.branchIds || u.branchIds.length === 0
            const branchNames = allBranches
              ? 'Full access'
              : u.branchIds.map((id: string) => branches.find((b) => b.id === id)?.name ?? id).join(', ')

            return (
              <div key={u.id} className={`card p-4 flex items-center gap-4 ${!u.isActive ? 'opacity-60' : ''}`}>
                {/* Avatar */}
                <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center text-sm font-semibold text-primary-700 flex-shrink-0">
                  {u.name?.[0]?.toUpperCase()}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900">{u.name}</span>
                    {isSelf && <span className="text-xs bg-primary-100 text-primary-700 px-1.5 py-0.5 rounded-full">You</span>}
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${ROLE_COLORS[u.role] ?? 'bg-gray-100 text-gray-600'}`}>
                      {u.role === 'owner' ? 'Owner' : u.role === 'manager' ? rn.manager : u.role === 'viewer' ? rn.viewer : rn.cashier}
                    </span>
                    {!u.isActive && (
                      <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full">Inactive</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">{u.phone}</div>
                  <div className="text-xs text-gray-400 mt-0.5 truncate">{branchNames}</div>
                </div>

                {/* Actions — owner only, not on self */}
                {role === 'owner' && !isSelf && (
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <button type="button"
                      onClick={() => setResetUser(u)}
                      className="flex items-center gap-1 text-xs text-gray-500 hover:text-primary-600"
                      title="Reset PIN">
                      <KeyRound className="w-3.5 h-3.5" />
                      Reset PIN
                    </button>
                    {u.isActive ? (
                      <button type="button"
                        onClick={() => deactivate.mutate(u.id)}
                        disabled={deactivate.isPending}
                        className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700"
                        title="Deactivate user">
                        <UserX className="w-3.5 h-3.5" />
                        Deactivate
                      </button>
                    ) : (
                      <button type="button"
                        onClick={() => activate.mutate(u.id)}
                        disabled={activate.isPending}
                        className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700"
                        title="Activate user">
                        <UserCheck className="w-3.5 h-3.5" />
                        Activate
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {showAdd   && <AddUserModal branches={branches} domainType={domainType} onClose={() => setShowAdd(false)} />}
      {resetUser && <ResetPinModal user={resetUser} onClose={() => setResetUser(null)} />}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
// One login, one or more firms (business names). Each is a card; the owner edits a firm or adds another.

function FirmCard({ firm, index, current, canEdit, onEdit }: { firm: Firm; index: number; current: boolean; canEdit: boolean; onEdit: () => void }) {
  const cfg = firm.domainConfig as Record<string, any>
  const addr = firm.address ?? {}
  const tone = FIRM_TONES[index % FIRM_TONES.length]!
  const nums = firm.numbering.style === 'plain' ? `${firm.numbering.prefix ?? ''}${firm.numbering.next ?? ''} next` : 'Standard (restarts each April)'
  return (
    <div className="card overflow-hidden">
      <div className={`h-1 ${tone.bar}`} />
      <div className="p-6">
        <div className="flex items-start gap-3 mb-4">
          <FirmAvatar firm={firm} toneIndex={index} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-gray-900 truncate">{firm.name}</div>
            <div className="text-xs text-gray-500 mt-0.5">{KIND_LABEL[firm.kind]} firm{current ? ' · you are working here' : ''}</div>
          </div>
          {canEdit && <button type="button" onClick={onEdit} className="btn-ghost text-sm"><Pencil className="w-4 h-4" /> Edit</button>}
        </div>
        <div className="space-y-2 text-sm text-gray-600">
          <div className="flex items-center gap-2"><FileText className="w-4 h-4 text-gray-400" /> {firm.gstin || 'GSTIN not set'}</div>
          <div className="flex items-start gap-2"><MapPin className="w-4 h-4 text-gray-400 mt-0.5" /><span>{[addr.line1, addr.city, addr.pincode].filter(Boolean).join(', ') || 'Address not set'}</span></div>
          <div className="flex items-center gap-2"><Building2 className="w-4 h-4 text-gray-400" /> State code {firm.stateCode || '—'}</div>
        </div>
        <dl className="text-sm space-y-2 mt-4 pt-4 border-t border-gray-100">
          <div className="flex justify-between"><dt className="text-gray-500">Bill numbers</dt><dd className="font-mono text-xs">{nums}</dd></div>
          {firm.kind === 'transport' && <div className="flex justify-between"><dt className="text-gray-500">Usual GST</dt><dd className="text-right">{(GST_MODE_OPTIONS.find(([v]) => v === (cfg['default_gst_mode'] ?? 'rcm')) ?? ['', ''])[1]}</dd></div>}
          {firm.kind === 'transport' && <div className="flex justify-between"><dt className="text-gray-500">SAC code</dt><dd className="font-mono">{cfg['default_sac_code'] ?? '996791'}</dd></div>}
          <div className="flex justify-between"><dt className="text-gray-500">PAN</dt><dd className="font-mono">{cfg['pan'] || '—'}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Bank</dt><dd className="text-right">{cfg['bank_name'] ? `${cfg['bank_name']} · ${cfg['bank_account_no'] ?? ''}` : '—'}</dd></div>
          <div className="flex justify-between"><dt className="text-gray-500">Logo</dt><dd>{firm.logo ? 'Added' : 'Not added'}</dd></div>
        </dl>
      </div>
    </div>
  )
}

export function BranchesPage() {
  const { data: branches } = useBranches()
  const { data: firmData, isLoading } = useFirms()
  const role = useAuthStore((s) => s.user?.role)
  const currentId = useAuthStore((s) => s.branch?.id)
  const [editing, setEditing] = useState<Firm | null>(null)
  const [adding, setAdding] = useState(false)
  const [view, setView] = useState<'business' | 'users'>('business')

  const list: any[] = branches ?? []
  const firms = firmData?.firms ?? []

  if (view === 'users') {
    return (
      <div>
        <PageHeader title="Staff" subtitle="People who can use this app" />
        <div className="p-8">
          <UsersPanel branches={list} domainType="transport" onBack={() => setView('business')} />
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Firms & Staff"
        subtitle="Your business names and the people who use this app"
        action={
          <div className="flex items-center gap-2">
            {(role === 'owner' || role === 'manager') && (
              <button type="button" onClick={() => setView('users')} className="btn-ghost">
                <Users className="w-4 h-4" /> Manage Users
              </button>
            )}
            {role === 'owner' && firms.length < 5 && (
              <button type="button" onClick={() => setAdding(true)} className="btn-primary">
                <Plus className="w-4 h-4" /> Add firm
              </button>
            )}
          </div>
        }
      />

      <div className="p-8">
        {isLoading && <div className="text-gray-400 text-center py-12">Loading…</div>}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 max-w-6xl">
          {firms.map((f, i) => (
            <FirmCard key={f.id} firm={f} index={i} current={f.id === currentId} canEdit={role === 'owner'} onEdit={() => setEditing(f)} />
          ))}
        </div>
        {role === 'owner' && firms.length === 1 && (
          <p className="text-sm text-gray-500 mt-6 max-w-xl">Bill under more than one business name? Use <strong>Add firm</strong> — you will switch between them from the top of the menu, with the same login.</p>
        )}
      </div>

      {editing && <BusinessModal branch={editing} onClose={() => setEditing(null)} />}
      {adding && <AddFirmModal firms={firms} currentFirmId={currentId} onClose={() => setAdding(false)}
        onAdded={(f) => { setAdding(false); setEditing(f) }} />}
    </div>
  )
}
