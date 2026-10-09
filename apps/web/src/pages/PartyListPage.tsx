// src/pages/PartyListPage.tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useParties, useCreateParty } from '@/hooks/useApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { useAuthStore } from '@/store/auth.store'
import { getEntityConfig } from '@/lib/entityConfig'
import { Plus, Search, Users, User } from 'lucide-react'

function formatINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

function metaVal(meta: unknown, key: string): string {
  if (!meta || typeof meta !== 'object') return '—'
  const v = (meta as Record<string, unknown>)[key]
  return v != null && v !== '' ? String(v) : '—'
}

// Service-first domains: hide suppliers tab by default and filter to customers
const SERVICE_DOMAINS = new Set([
  'clinic','diagnostic_lab','optical','pharmacy','gym','coaching',
  'salon','tiffin','hotel','pest_control','photography','repair','laundry',
])

export function PartyListPage() {
  const domainType = useAuthStore((s: any) => s.branch?.domainType ?? '')
  const cfg        = getEntityConfig(domainType)
  const isService  = SERVICE_DOMAINS.has(domainType)

  const [search,       setSearch]       = useState('')
  const [type,         setType]         = useState(isService ? 'customer' : '')
  const [showAddModal, setShowAddModal] = useState(false)

  const { data, isLoading } = useParties({ search: search || undefined, type: type || undefined, limit: 100 })

  // For service domains: split customers vs suppliers into tabs
  const [tab, setTab] = useState<'customers'|'suppliers'>('customers')
  const showTabs = isService

  const parties: any[] = data?.data ?? []
  const displayed = showTabs
    ? parties.filter((p: any) => tab === 'customers' ? p.type !== 'supplier' : p.type === 'supplier')
    : parties

  const listCols = cfg.listColumns

  return (
    <div>
      <PageHeader
        title={isService ? cfg.plural : 'Parties'}
        subtitle={isService ? `Manage your ${cfg.singularLower} records` : 'Customers and suppliers'}
        action={
          <button onClick={() => setShowAddModal(true)} className="btn-primary">
            <Plus className="w-4 h-4" /> Add {isService ? cfg.singular : 'Party'}
          </button>
        }
      />

      <div className="p-8">

        {/* Tab bar for service domains */}
        {showTabs && (
          <div className="flex gap-1 mb-5 border-b border-gray-200">
            <button
              type="button"
              onClick={() => { setTab('customers'); setType('customer') }}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'customers' ? 'border-primary-500 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              <User className="w-3.5 h-3.5 inline mr-1.5" />{cfg.plural}
            </button>
            <button
              type="button"
              onClick={() => { setTab('suppliers'); setType('supplier') }}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'suppliers' ? 'border-primary-500 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              <Users className="w-3.5 h-3.5 inline mr-1.5" />Suppliers
            </button>
          </div>
        )}

        <div className="flex gap-3 mb-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              placeholder={`Search by name or phone...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-9"
            />
          </div>
          {!showTabs && (
            <select title="Filter by type" value={type} onChange={(e) => setType(e.target.value)} className="input w-44">
              <option value="">All types</option>
              <option value="customer">Customers</option>
              <option value="supplier">Suppliers</option>
            </select>
          )}
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-5 py-3 font-medium text-gray-500">Name</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Phone</th>
                {!showTabs && <th className="text-left px-5 py-3 font-medium text-gray-500">Type</th>}
                {listCols.map(col => (
                  <th key={col.key} className="text-left px-5 py-3 font-medium text-gray-500">{col.label}</th>
                ))}
                <th className="text-right px-5 py-3 font-medium text-gray-500">Balance</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={3 + listCols.length + (showTabs ? 0 : 1)} className="text-center py-12 text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && displayed.length === 0 && (
                <tr><td colSpan={3 + listCols.length + (showTabs ? 0 : 1)} className="text-center py-12 text-gray-400">
                  No {tab === 'customers' ? cfg.singularLower + 's' : 'suppliers'} found
                </td></tr>
              )}
              {displayed.map((party: any) => (
                <tr key={party.id} className="table-row">
                  <td className="px-5 py-3">
                    <Link to={`/parties/${party.id}`} className="font-medium text-primary-600 hover:underline">
                      {party.name}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-gray-500">{party.phone ?? '—'}</td>
                  {!showTabs && (
                    <td className="px-5 py-3 text-gray-500 capitalize">{party.type}</td>
                  )}
                  {listCols.map(col => (
                    <td key={col.key} className="px-5 py-3 text-gray-500">
                      {col.fromMeta ? metaVal(party.meta, col.key) : (party[col.key] ?? '—')}
                    </td>
                  ))}
                  <td className={`px-5 py-3 text-right font-medium ${
                    Number(party.balance) > 0 ? 'text-amber-600' :
                    Number(party.balance) < 0 ? 'text-red-600' : 'text-gray-400'
                  }`}>
                    {Number(party.balance) === 0 ? '—' : formatINR(Math.abs(Number(party.balance)))}
                    {Number(party.balance) !== 0 && (
                      <span className="text-xs ml-1 font-normal">
                        {Number(party.balance) > 0 ? '(owes us)' : '(we owe)'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAddModal && (
        <AddEntityModal
          domainType={domainType}
          defaultType={isService ? 'customer' : 'customer'}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  )
}

interface AddEntityModalProps {
  domainType:  string
  defaultType: string
  onClose:     () => void
}

function AddEntityModal({ domainType, defaultType, onClose }: AddEntityModalProps) {
  const cfg         = getEntityConfig(domainType)
  const createParty = useCreateParty()
  const isService   = SERVICE_DOMAINS.has(domainType)

  const [form, setForm] = useState({
    type:        defaultType,
    name:        '',
    phone:       '',
    creditLimit: '',
    email:       '',
  })
  const [meta, setMeta] = useState<Record<string, string>>({})

  function setF(k: string, v: string) { setForm(p => ({ ...p, [k]: v })) }
  function setM(k: string, v: string) { setMeta(p => ({ ...p, [k]: v })) }

  async function handleSubmit() {
    if (!form.name.trim()) return
    // Remove empty meta values
    const cleanMeta = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== ''))
    await createParty.mutateAsync({
      type:        form.type,
      name:        form.name.trim(),
      phone:       form.phone || undefined,
      email:       form.email || undefined,
      creditLimit: form.creditLimit ? Number(form.creditLimit) : undefined,
      meta:        cleanMeta,
    })
    onClose()
  }

  const modalTitle = isService
    ? (form.type === 'supplier' ? 'Add Supplier' : `Add ${cfg.singular}`)
    : 'Add Party'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h3 className="text-base font-semibold text-gray-900 mb-4">{modalTitle}</h3>

          <div className="space-y-3">

            {/* Type selector — only shown for non-service domains or when adding supplier */}
            {isService ? (
              <div>
                <label className="label" htmlFor="modal-type">Type</label>
                <select id="modal-type" title="Party type" value={form.type} onChange={(e) => setF('type', e.target.value)} className="input">
                  <option value="customer">{cfg.singular}</option>
                  <option value="supplier">Supplier</option>
                </select>
              </div>
            ) : (
              <div>
                <label className="label" htmlFor="modal-type">Type</label>
                <select id="modal-type" title="Party type" value={form.type} onChange={(e) => setF('type', e.target.value)} className="input">
                  <option value="customer">Customer</option>
                  <option value="supplier">Supplier</option>
                  <option value="both">Both</option>
                </select>
              </div>
            )}

            <div>
              <label className="label">
                {form.type !== 'supplier' && isService ? `${cfg.singular} Name` : 'Name'}
                <span className="text-red-500 ml-0.5">*</span>
              </label>
              <input
                autoFocus
                value={form.name}
                onChange={(e) => setF('name', e.target.value)}
                className="input"
                placeholder="Full name"
              />
            </div>

            <div>
              <label className="label">Phone</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setF('phone', e.target.value)}
                className="input"
                placeholder="10-digit mobile"
              />
            </div>

            <div>
              <label className="label">Email (optional)</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setF('email', e.target.value)}
                className="input"
                placeholder="email@example.com"
              />
            </div>

            {/* Domain-specific meta fields — only for customers */}
            {form.type !== 'supplier' && cfg.metaFields.length > 0 && (
              <>
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                    {cfg.singular} Details
                  </p>
                </div>
                {cfg.metaFields.map(field => (
                  <div key={field.key}>
                    <label className="label">
                      {field.label}
                      {!field.optional && <span className="text-red-500 ml-0.5">*</span>}
                    </label>
                    {field.type === 'select' ? (
                      <select
                        title={field.label}
                        value={meta[field.key] ?? ''}
                        onChange={(e) => setM(field.key, e.target.value)}
                        className="input"
                      >
                        <option value="">— Select —</option>
                        {field.options?.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                        value={meta[field.key] ?? ''}
                        onChange={(e) => setM(field.key, e.target.value)}
                        className="input"
                        placeholder={field.placeholder}
                      />
                    )}
                  </div>
                ))}
              </>
            )}

            <div>
              <label className="label">Credit Limit (optional)</label>
              <input
                type="number"
                value={form.creditLimit}
                onChange={(e) => setF('creditLimit', e.target.value)}
                className="input"
                placeholder="0"
              />
            </div>

            {/* Price Group — only shown when feature is enabled */}
            {localStorage.getItem('pos_price_groups') === 'true' && form.type !== 'supplier' && (
              <div>
                <label className="label">Price Group</label>
                <select
                  title="Price group"
                  value={meta.priceGroup ?? ''}
                  onChange={(e) => setM('priceGroup', e.target.value)}
                  className="input"
                >
                  <option value="">Retail (default)</option>
                  <option value="wholesale">Wholesale</option>
                  <option value="special">Special</option>
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  Wholesale/Special rates must be set on each product.
                </p>
              </div>
            )}
          </div>

          <div className="flex gap-2 mt-5">
            <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!form.name.trim() || createParty.isPending}
              className="btn-primary flex-1 justify-center"
            >
              {createParty.isPending ? 'Saving…' : `Add ${form.type !== 'supplier' && isService ? cfg.singular : 'Party'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
