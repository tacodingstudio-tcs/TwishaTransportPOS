// src/pages/DiscountRulesPage.tsx
import { useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  useDiscountRules, useCreateDiscountRule, useUpdateDiscountRule, useDeleteDiscountRule,
} from '@/hooks/useApi'
import { Plus, Pencil, Trash2, Tag, ToggleLeft, ToggleRight } from 'lucide-react'

const RULE_TYPES = [
  { value: 'percentage', label: 'Percentage off',  desc: 'e.g. 10% off all items' },
  { value: 'flat',       label: 'Flat discount',    desc: 'e.g. ₹50 off the item' },
  { value: 'qty_slab',   label: 'Qty slab',         desc: 'e.g. buy 5+ get 15% off' },
  { value: 'bogo',       label: 'BOGO / Free qty',  desc: 'e.g. buy 2 get 1 free' },
]

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function empty() {
  return {
    name:       '',
    type:       'percentage' as string,
    isActive:   true,
    priority:   0,
    validFrom:  '',
    validTo:    '',
    conditions: { minQty: '', minAmt: '', dayOfWeek: [] as number[] },
    action:     { discountPct: '', discountAmt: '', freeQty: '', slabs: [] as { minQty: number; discountPct: number }[] },
  }
}

type FormState = ReturnType<typeof empty>

function RuleForm({
  initial, onSave, onCancel, saving,
}: {
  initial: FormState
  onSave:  (data: FormState) => void
  onCancel: () => void
  saving:  boolean
}) {
  const [form, setForm] = useState<FormState>(initial)

  function patch(p: Partial<FormState>) { setForm(prev => ({ ...prev, ...p })) }
  function patchCond(p: Partial<FormState['conditions']>) {
    setForm(prev => ({ ...prev, conditions: { ...prev.conditions, ...p } }))
  }
  function patchAction(p: Partial<FormState['action']>) {
    setForm(prev => ({ ...prev, action: { ...prev.action, ...p } }))
  }

  function toggleDay(d: number) {
    const days = form.conditions.dayOfWeek
    patchCond({ dayOfWeek: days.includes(d) ? days.filter(x => x !== d) : [...days, d] })
  }

  function addSlab() {
    patchAction({ slabs: [...form.action.slabs, { minQty: 1, discountPct: 0 }] })
  }
  function removeSlab(i: number) {
    patchAction({ slabs: form.action.slabs.filter((_, idx) => idx !== i) })
  }
  function patchSlab(i: number, p: Partial<{ minQty: number; discountPct: number }>) {
    patchAction({ slabs: form.action.slabs.map((s, idx) => idx === i ? { ...s, ...p } : s) })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Rule name</label>
          <input className="input" value={form.name} onChange={e => patch({ name: e.target.value })} placeholder="e.g. Weekend 10% Off" />
        </div>
        <div>
          <label className="label">Type</label>
          <select title="Rule type" className="input" value={form.type} onChange={e => patch({ type: e.target.value })}>
            {RULE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>)}
          </select>
        </div>
      </div>

      {/* Action fields by type */}
      <div className="card bg-gray-50 p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Discount action</p>
        {form.type === 'percentage' && (
          <div className="flex items-center gap-2">
            <label className="label w-28 shrink-0">Discount %</label>
            <input type="number" min={0} max={100} className="input w-28"
              value={form.action.discountPct}
              onChange={e => patchAction({ discountPct: e.target.value })} />
          </div>
        )}
        {form.type === 'flat' && (
          <div className="flex items-center gap-2">
            <label className="label w-28 shrink-0">Flat ₹ off</label>
            <input type="number" min={0} className="input w-28"
              value={form.action.discountAmt}
              onChange={e => patchAction({ discountAmt: e.target.value })} />
          </div>
        )}
        {form.type === 'bogo' && (
          <div className="flex items-center gap-2">
            <label className="label w-28 shrink-0">Free qty</label>
            <input type="number" min={1} className="input w-28"
              value={form.action.freeQty}
              onChange={e => patchAction({ freeQty: e.target.value })} />
            <span className="text-xs text-gray-500">units free (e.g. buy 2 get 1 free → enter 1)</span>
          </div>
        )}
        {form.type === 'qty_slab' && (
          <div className="space-y-2">
            {form.action.slabs.map((slab, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-20">Min qty ≥</span>
                <input type="number" min={1} className="input w-20"
                  value={slab.minQty}
                  onChange={e => patchSlab(i, { minQty: parseInt(e.target.value) || 1 })} />
                <span className="text-xs text-gray-500">→ discount %</span>
                <input type="number" min={0} max={100} className="input w-20"
                  value={slab.discountPct}
                  onChange={e => patchSlab(i, { discountPct: parseFloat(e.target.value) || 0 })} />
                <button type="button" title="Remove slab" onClick={() => removeSlab(i)}
                  className="p-1 text-gray-300 hover:text-red-500 rounded">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button type="button" onClick={addSlab}
              className="text-xs text-primary-600 hover:text-primary-700 font-medium">
              + Add slab
            </button>
          </div>
        )}
      </div>

      {/* Conditions */}
      <div className="card bg-gray-50 p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Conditions (optional)</p>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex items-center gap-2">
            <label className="label w-24 shrink-0">Min qty</label>
            <input type="number" min={0} className="input"
              value={form.conditions.minQty}
              onChange={e => patchCond({ minQty: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <label className="label w-24 shrink-0">Min cart ₹</label>
            <input type="number" min={0} className="input"
              value={form.conditions.minAmt}
              onChange={e => patchCond({ minAmt: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label mb-1">Days of week (leave empty = all days)</label>
          <div className="flex gap-1.5">
            {DAYS.map((d, i) => (
              <button
                key={i}
                type="button"
                onClick={() => toggleDay(i)}
                className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                  form.conditions.dayOfWeek.includes(i)
                    ? 'bg-primary-100 border-primary-400 text-primary-700'
                    : 'border-gray-200 text-gray-500 hover:bg-gray-100'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Validity dates + priority */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="label">Valid from</label>
          <input type="date" className="input" value={form.validFrom} onChange={e => patch({ validFrom: e.target.value })} />
        </div>
        <div>
          <label className="label">Valid to</label>
          <input type="date" className="input" value={form.validTo} onChange={e => patch({ validTo: e.target.value })} />
        </div>
        <div>
          <label className="label">Priority (0–100)</label>
          <input type="number" min={0} max={100} className="input"
            value={form.priority}
            onChange={e => patch({ priority: parseInt(e.target.value) || 0 })} />
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={() => onSave(form)}
          disabled={saving || !form.name.trim()}
          className="btn-primary"
        >
          {saving ? 'Saving…' : 'Save rule'}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">Cancel</button>
      </div>
    </div>
  )
}

function formToPayload(form: FormState) {
  const conditions: any = {}
  if (form.conditions.minQty !== '')  conditions.minQty      = Number(form.conditions.minQty)
  if (form.conditions.minAmt !== '')  conditions.minAmt      = Number(form.conditions.minAmt)
  if (form.conditions.dayOfWeek.length) conditions.dayOfWeek = form.conditions.dayOfWeek

  const action: any = {}
  if (form.type === 'percentage' && form.action.discountPct !== '') action.discountPct = Number(form.action.discountPct)
  if (form.type === 'flat'       && form.action.discountAmt !== '') action.discountAmt = Number(form.action.discountAmt)
  if (form.type === 'bogo'       && form.action.freeQty     !== '') action.freeQty     = Number(form.action.freeQty)
  if (form.type === 'qty_slab')                                      action.slabs       = form.action.slabs

  return {
    name:       form.name.trim(),
    type:       form.type,
    isActive:   form.isActive,
    priority:   form.priority,
    conditions,
    action,
    validFrom:  form.validFrom || undefined,
    validTo:    form.validTo   || undefined,
  }
}

function ruleToForm(rule: any): FormState {
  return {
    name:       rule.name,
    type:       rule.type,
    isActive:   rule.isActive,
    priority:   rule.priority,
    validFrom:  rule.validFrom ? rule.validFrom.slice(0, 10) : '',
    validTo:    rule.validTo   ? rule.validTo.slice(0, 10)   : '',
    conditions: {
      minQty:     rule.conditions?.minQty     ?? '',
      minAmt:     rule.conditions?.minAmt     ?? '',
      dayOfWeek:  rule.conditions?.dayOfWeek  ?? [],
    },
    action: {
      discountPct: rule.action?.discountPct ?? '',
      discountAmt: rule.action?.discountAmt ?? '',
      freeQty:     rule.action?.freeQty     ?? '',
      slabs:       rule.action?.slabs       ?? [],
    },
  }
}

export function DiscountRulesPage() {
  const { data: rules = [], isLoading } = useDiscountRules()
  const createRule = useCreateDiscountRule()
  const updateRule = useUpdateDiscountRule()
  const deleteRule = useDeleteDiscountRule()

  const [showCreate, setShowCreate] = useState(false)
  const [editingId,  setEditingId]  = useState<string | null>(null)

  async function handleCreate(form: FormState) {
    await createRule.mutateAsync(formToPayload(form))
    setShowCreate(false)
  }

  async function handleUpdate(id: string, form: FormState) {
    await updateRule.mutateAsync({ id, ...formToPayload(form) })
    setEditingId(null)
  }

  async function handleToggle(rule: any) {
    await updateRule.mutateAsync({ id: rule.id, isActive: !rule.isActive })
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this discount rule?')) return
    await deleteRule.mutateAsync(id)
  }

  const typeLabel = (type: string) => RULE_TYPES.find(t => t.value === type)?.label ?? type

  return (
    <div>
      <PageHeader
        title="Discount Rules"
        subtitle="Auto-apply discounts at billing time"
        action={
          <button type="button" onClick={() => setShowCreate(true)} className="btn-primary gap-2">
            <Plus className="w-4 h-4" /> New rule
          </button>
        }
      />

      <div className="p-8 space-y-4 max-w-4xl">
        {showCreate && (
          <div className="card p-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">New discount rule</h3>
            <RuleForm
              initial={empty()}
              onSave={handleCreate}
              onCancel={() => setShowCreate(false)}
              saving={createRule.isPending}
            />
          </div>
        )}

        {isLoading && <p className="text-gray-400 text-sm">Loading…</p>}

        {!isLoading && (rules as any[]).length === 0 && !showCreate && (
          <div className="card p-16 text-center text-gray-400 text-sm">
            No discount rules yet. Click "New rule" to create one.
          </div>
        )}

        {(rules as any[]).map((rule: any) => (
          editingId === rule.id ? (
            <div key={rule.id} className="card p-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-4">Edit rule</h3>
              <RuleForm
                initial={ruleToForm(rule)}
                onSave={(form) => handleUpdate(rule.id, form)}
                onCancel={() => setEditingId(null)}
                saving={updateRule.isPending}
              />
            </div>
          ) : (
            <div key={rule.id} className={`card p-4 flex items-start gap-4 ${!rule.isActive ? 'opacity-60' : ''}`}>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Tag className="w-4 h-4 text-primary-500" />
                  <span className="font-medium text-gray-900">{rule.name}</span>
                  <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                    {typeLabel(rule.type)}
                  </span>
                  {!rule.isActive && (
                    <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">Inactive</span>
                  )}
                </div>
                <div className="text-xs text-gray-500 space-x-3">
                  {rule.action?.discountPct  != null && <span>{rule.action.discountPct}% off</span>}
                  {rule.action?.discountAmt  != null && <span>₹{rule.action.discountAmt} off</span>}
                  {rule.action?.freeQty      != null && <span>{rule.action.freeQty} free unit(s)</span>}
                  {rule.action?.slabs?.length         && <span>{rule.action.slabs.length} qty slabs</span>}
                  {rule.conditions?.minQty   != null && <span>min qty {rule.conditions.minQty}</span>}
                  {rule.conditions?.minAmt   != null && <span>min cart ₹{rule.conditions.minAmt}</span>}
                  {rule.conditions?.dayOfWeek?.length && <span>days: {rule.conditions.dayOfWeek.map((d: number) => DAYS[d]).join(', ')}</span>}
                  {rule.validFrom && <span>from {rule.validFrom.slice(0, 10)}</span>}
                  {rule.validTo   && <span>to {rule.validTo.slice(0, 10)}</span>}
                  <span>priority {rule.priority}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  title={rule.isActive ? 'Deactivate' : 'Activate'}
                  onClick={() => handleToggle(rule)}
                  className="text-gray-400 hover:text-primary-600 p-1 rounded"
                >
                  {rule.isActive
                    ? <ToggleRight className="w-5 h-5 text-primary-500" />
                    : <ToggleLeft className="w-5 h-5" />}
                </button>
                <button
                  type="button"
                  title="Edit rule"
                  onClick={() => setEditingId(rule.id)}
                  className="text-gray-400 hover:text-gray-700 p-1 rounded"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  title="Delete rule"
                  onClick={() => handleDelete(rule.id)}
                  className="text-gray-300 hover:text-red-500 p-1 rounded"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          )
        ))}
      </div>
    </div>
  )
}
