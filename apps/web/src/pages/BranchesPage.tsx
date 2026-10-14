// src/pages/BranchesPage.tsx
import { useState } from 'react'
import {
  useBranches, useUpdateBranch,
  useUsers, useCreateUser, useResetUserPin, useDeactivateUser, useActivateUser,
} from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  Plus, Building2, MapPin, FileText, Users, KeyRound, UserX, UserCheck, ArrowLeft, Truck, Pencil,
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
  const cfg = (branch.domainConfig ?? {}) as Record<string, any>

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
        lr_prefix: form.lrPrefix.trim().toUpperCase() || 'LR',
        default_gst_mode: form.gstMode,
        default_sac_code: form.sac.trim() || '996791',
        eway_threshold: Number(form.ewayLimit) || 50000,
        compliance_alert_days: Number(form.alertDays) || 30,
        pod_required_before_billing: form.podFirst,
        pan: form.pan.trim().toUpperCase(),
        bank_name: form.bankName.trim(), bank_account_no: form.bankAcc.trim(), bank_ifsc: form.bankIfsc.trim().toUpperCase(),
        gta_declaration: form.declaration.trim(), bill_terms: form.terms.trim(),
      },
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-xl max-h-[92vh] overflow-y-auto p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-5">Edit business</h3>

        <div className="space-y-4">
          <div>
            <label className="label">Business name *</label>
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
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Printed on your bills</h4>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">PAN</label><input className="input" maxLength={10} placeholder="AAAAA9999A" value={form.pan} onChange={set('pan')} /></div>
              <div><label className="label">Bank name</label><input className="input" value={form.bankName} onChange={set('bankName')} /></div>
              <div><label className="label">Account no</label><input className="input" value={form.bankAcc} onChange={set('bankAcc')} /></div>
              <div><label className="label">IFSC</label><input className="input" maxLength={11} value={form.bankIfsc} onChange={set('bankIfsc')} /></div>
              <div className="col-span-2">
                <label className="label">GTA declaration <span className="text-gray-400 font-normal">(blank = standard wording for the GST treatment used)</span></label>
                <textarea className="input h-16 resize-none" value={form.declaration} onChange={(e) => setForm({ ...form, declaration: e.target.value })} />
              </div>
              <div className="col-span-2">
                <label className="label">Terms &amp; conditions <span className="text-gray-400 font-normal">(one per line)</span></label>
                <textarea className="input h-20 resize-none" value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
              </div>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
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
          </div>
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
// One tenant = one business = one branch. This page edits that business and manages its users.

export function BranchesPage() {
  const { data: branches, isLoading } = useBranches()
  const role = useAuthStore((s) => s.user?.role)
  const [editing, setEditing] = useState(false)
  const [view, setView] = useState<'business' | 'users'>('business')

  const list: any[] = branches ?? []
  const b = list[0]
  const domainType = (b?.domainType as string | undefined) ?? 'transport'
  const cfg = (b?.domainConfig ?? {}) as Record<string, any>
  const addr = b?.address ?? {}

  if (view === 'users') {
    return (
      <div>
        <PageHeader title="Staff" subtitle="People who can use this app" />
        <div className="p-8">
          <UsersPanel branches={list} domainType={domainType} onBack={() => setView('business')} />
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="My Business & Staff"
        subtitle="Your business details and the people who use this app"
        action={
          <div className="flex items-center gap-2">
            {(role === 'owner' || role === 'manager') && (
              <button type="button" onClick={() => setView('users')} className="btn-ghost">
                <Users className="w-4 h-4" /> Manage Users
              </button>
            )}
            {role === 'owner' && b && (
              <button type="button" onClick={() => setEditing(true)} className="btn-primary">
                <Pencil className="w-4 h-4" /> Edit business
              </button>
            )}
          </div>
        }
      />

      <div className="p-8">
        {isLoading && <div className="text-gray-400 text-center py-12">Loading…</div>}

        {b && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl">
            <div className="card p-6">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
                  <Truck className="w-5 h-5 text-primary-600" />
                </div>
                <div>
                  <div className="font-semibold text-gray-900">{b.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">Transport business</div>
                </div>
              </div>
              <div className="space-y-2 text-sm text-gray-600">
                <div className="flex items-center gap-2"><FileText className="w-4 h-4 text-gray-400" /> {b.gstin || 'GSTIN not set'}</div>
                <div className="flex items-start gap-2">
                  <MapPin className="w-4 h-4 text-gray-400 mt-0.5" />
                  <span>{[addr.line1, addr.city, addr.pincode].filter(Boolean).join(', ') || 'Address not set'}</span>
                </div>
                <div className="flex items-center gap-2"><Building2 className="w-4 h-4 text-gray-400" /> State code {b.stateCode || '—'}</div>
              </div>
            </div>

            <div className="card p-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-4">Settings</h3>
              <dl className="text-sm space-y-2.5">
                <div className="flex justify-between"><dt className="text-gray-500">LR prefix</dt><dd className="font-mono">{cfg['lr_prefix'] ?? 'LR'}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Usual GST</dt><dd>{(GST_MODE_OPTIONS.find(([v]) => v === (cfg['default_gst_mode'] ?? 'rcm')) ?? ['', ''])[1]}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">SAC code</dt><dd className="font-mono">{cfg['default_sac_code'] ?? '996791'}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">E-way bill above</dt><dd>₹{Number(cfg['eway_threshold'] ?? 50000).toLocaleString('en-IN')}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Paper alerts</dt><dd>{cfg['compliance_alert_days'] ?? 30} days before they end</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">PAN</dt><dd className="font-mono">{cfg['pan'] || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Bank</dt><dd>{cfg['bank_name'] ? `${cfg['bank_name']} · ${cfg['bank_account_no'] ?? ''}` : '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Signed copy needed before bill</dt><dd>{cfg['pod_required_before_billing'] ? 'Yes' : 'No'}</dd></div>
              </dl>
            </div>
          </div>
        )}
      </div>

      {editing && b && <BusinessModal branch={b} onClose={() => setEditing(false)} />}
    </div>
  )
}
