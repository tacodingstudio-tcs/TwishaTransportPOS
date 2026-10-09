// src/pages/inventory/SuppliersPage.tsx
import { useState } from 'react'
import { useSuppliers, useCreateSupplier, useUpdateSupplier, useDeleteSupplier } from '@/hooks/useApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { Plus, Search, Pencil, Trash2, Building2 } from 'lucide-react'

function formatINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

const emptyForm = {
  name: '', contactPerson: '', phone: '', email: '',
  gstin: '', creditDays: '0', creditLimit: '',
  leadTimeDays: '0', notes: '',
}

function SupplierModal({
  supplier,
  onClose,
}: {
  supplier?: any
  onClose: () => void
}) {
  const isEdit = !!supplier
  const createSupplier = useCreateSupplier()
  const updateSupplier = useUpdateSupplier()

  const [form, setForm] = useState(
    isEdit
      ? {
          name:          supplier.name ?? '',
          contactPerson: supplier.contactPerson ?? '',
          phone:         supplier.phone ?? '',
          email:         supplier.email ?? '',
          gstin:         supplier.gstin ?? '',
          creditDays:    String(supplier.creditDays ?? 0),
          creditLimit:   String(supplier.creditLimit ?? ''),
          leadTimeDays:  String(supplier.leadTimeDays ?? 0),
          notes:         supplier.notes ?? '',
        }
      : emptyForm
  )

  function f(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm({ ...form, [key]: e.target.value })
  }

  async function handleSubmit() {
    if (!form.name) return
    const payload = {
      name:          form.name,
      contactPerson: form.contactPerson || undefined,
      phone:         form.phone || undefined,
      email:         form.email || undefined,
      gstin:         form.gstin || undefined,
      creditDays:    Number(form.creditDays) || 0,
      creditLimit:   form.creditLimit ? Number(form.creditLimit) : undefined,
      leadTimeDays:  Number(form.leadTimeDays) || 0,
      notes:         form.notes || undefined,
    }
    if (isEdit) {
      await updateSupplier.mutateAsync({ id: supplier.id, data: payload })
    } else {
      await createSupplier.mutateAsync(payload)
    }
    onClose()
  }

  const isPending = createSupplier.isPending || updateSupplier.isPending

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-gray-900 mb-4">
          {isEdit ? 'Edit supplier' : 'Add supplier'}
        </h3>

        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="sup-name">Supplier name *</label>
            <input id="sup-name" autoFocus value={form.name} onChange={f('name')} className="input" placeholder="e.g. Reliance Fresh Wholesale" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="sup-contact">Contact person</label>
              <input id="sup-contact" value={form.contactPerson} onChange={f('contactPerson')} className="input" placeholder="Ramesh Gupta" />
            </div>
            <div>
              <label className="label" htmlFor="sup-phone">Phone</label>
              <input id="sup-phone" value={form.phone} onChange={f('phone')} className="input" placeholder="9876543210" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="sup-email">Email</label>
              <input id="sup-email" type="email" value={form.email} onChange={f('email')} className="input" placeholder="supplier@email.com" />
            </div>
            <div>
              <label className="label" htmlFor="sup-gstin">GSTIN</label>
              <input id="sup-gstin" value={form.gstin} onChange={f('gstin')} className="input" placeholder="27AAAAA0000A1Z5" maxLength={15} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="sup-credit-days">Credit days</label>
              <input id="sup-credit-days" type="number" min={0} value={form.creditDays} onChange={f('creditDays')} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="sup-credit-limit">Credit limit (₹)</label>
              <input id="sup-credit-limit" type="number" min={0} value={form.creditLimit} onChange={f('creditLimit')} className="input" placeholder="0" />
            </div>
            <div>
              <label className="label" htmlFor="sup-lead">Lead time (days)</label>
              <input id="sup-lead" type="number" min={0} value={form.leadTimeDays} onChange={f('leadTimeDays')} className="input" />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="sup-notes">Notes</label>
            <textarea id="sup-notes" value={form.notes} onChange={f('notes')} className="input" rows={2} placeholder="Any notes about this supplier..." />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={isPending} className="btn-primary flex-1 justify-center">
            {isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Supplier'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function SuppliersPage() {
  const [search, setSearch]       = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editSupplier, setEditSupplier] = useState<any | null>(null)

  const { data, isLoading } = useSuppliers({ q: search || undefined, limit: 50 })
  const deleteSupplier      = useDeleteSupplier()

  function handleDelete(id: string, name: string) {
    if (!confirm(`Delete supplier "${name}"? This cannot be undone.`)) return
    deleteSupplier.mutate(id)
  }

  return (
    <div>
      <PageHeader
        title="Suppliers"
        subtitle={data?.meta ? `${data.meta.total} suppliers` : undefined}
        action={
          <button type="button" onClick={() => setShowModal(true)} className="btn-primary">
            <Plus className="w-4 h-4" /> Add Supplier
          </button>
        }
      />

      <div className="p-8">
        <div className="relative max-w-sm mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            placeholder="Search suppliers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9"
          />
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-5 py-3 font-medium text-gray-500">Name</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Contact</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">GSTIN</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Credit Days</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Credit Limit</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Balance</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={7} className="text-center py-12 text-gray-400">Loading...</td></tr>}
              {!isLoading && data?.data?.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-12">
                    <Building2 className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                    <p className="text-gray-400">No suppliers yet. Add your first supplier.</p>
                  </td>
                </tr>
              )}
              {data?.data?.map((s: any) => (
                <tr key={s.id} className="table-row">
                  <td className="px-5 py-3">
                    <div className="font-medium text-gray-900">{s.name}</div>
                    {s.contactPerson && <div className="text-xs text-gray-400">{s.contactPerson}</div>}
                  </td>
                  <td className="px-5 py-3 text-gray-500">
                    {s.phone ?? '—'}
                    {s.email && <div className="text-xs text-gray-400">{s.email}</div>}
                  </td>
                  <td className="px-5 py-3 text-gray-500 font-mono text-xs">{s.gstin ?? '—'}</td>
                  <td className="px-5 py-3 text-right text-gray-600">{s.creditDays}d</td>
                  <td className="px-5 py-3 text-right text-gray-600">
                    {Number(s.creditLimit) > 0 ? formatINR(Number(s.creditLimit)) : '—'}
                  </td>
                  <td className={`px-5 py-3 text-right font-medium ${Number(s.balance) > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                    {Number(s.balance) !== 0 ? formatINR(Math.abs(Number(s.balance))) : '—'}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setEditSupplier(s)}
                        className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-md"
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(s.id, s.name)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && <SupplierModal onClose={() => setShowModal(false)} />}
      {editSupplier && <SupplierModal supplier={editSupplier} onClose={() => setEditSupplier(null)} />}
    </div>
  )
}
