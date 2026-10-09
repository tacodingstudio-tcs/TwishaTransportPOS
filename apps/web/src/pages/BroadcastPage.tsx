// src/pages/BroadcastPage.tsx
// WhatsApp Broadcast — send messages to customers via wa.me links.

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { broadcastApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import {
  MessageCircle, Send, Users, CheckCircle, Search, Filter,
  ChevronDown, ChevronUp, Save, Trash2, Pencil, X,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ── Types ─────────────────────────────────────────────────────────────────────

type Template = { id: string; label: string; body: string; builtin?: true }

// ── localStorage helpers ──────────────────────────────────────────────────────

const STORAGE_KEY = 'hk_broadcast_templates_v2'

function loadCustomTemplates(): Template[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') }
  catch { return [] }
}

function saveCustomTemplates(ts: Template[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ts))
}

// ── 10 Universal Built-in Templates ──────────────────────────────────────────
// Covers all domains: festive, birthday, anniversary, re-engagement, loyalty, etc.

const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'birthday',
    label: '🎂 Birthday Wishes',
    builtin: true,
    body: `🎂 Dear {name},\n\nWishing you a very *Happy Birthday*! 🎉🎊\n\nAs a birthday gift from us, enjoy *{discount}% OFF* on your next visit — valid till {validity}.\n\nWe hope to see you soon and celebrate with you!\n\nWith warm wishes,\n*{business}*`,
  },
  {
    id: 'anniversary',
    label: '💍 Anniversary Wishes',
    builtin: true,
    body: `💍 Dear {name},\n\nWishing you a very *Happy Anniversary*! 🌹✨\n\nThank you for being a valued part of our family. As our anniversary gift to you, enjoy a *special {discount}% discount* on your next visit.\n\nOffer valid till {validity}.\n\nWith love & regards,\n*{business}*`,
  },
  {
    id: 'festive',
    label: '🪔 Festive Season Offer',
    builtin: true,
    body: `🪔 Dear {name},\n\nWishing you and your family a joyful festive season! 🎉✨\n\nTo celebrate, we're offering *{discount}% OFF* exclusively for our valued customers.\n\nOffer valid till {validity}. Don't miss it!\n\nVisit us soon,\n*{business}*`,
  },
  {
    id: 'new_year',
    label: '🎆 New Year Offer',
    builtin: true,
    body: `🎆 Dear {name},\n\nWishing you a very *Happy New Year*! 🥳🎊\n\nAs we step into the new year, we have a *special offer* just for you:\n\n✨ *{discount}% OFF* on your next purchase/visit\n📅 Valid till {validity}\n\nThank you for your continued trust.\n\n*{business}*`,
  },
  {
    id: 'new_arrival',
    label: '🆕 New Arrival / Launch',
    builtin: true,
    body: `🆕 Dear {name},\n\nExciting news! We've just launched something new that we think you'll love! 🌟\n\nBe among the first to check it out and enjoy *exclusive early-bird pricing*.\n\nVisit us or call to know more — offer valid till {validity}.\n\n*{business}*`,
  },
  {
    id: 'loyalty',
    label: '⭐ Loyalty Reward',
    builtin: true,
    body: `⭐ Dear {name},\n\nThank you for being one of our most valued customers! 🙏\n\nAs a token of our appreciation, you've earned a *special loyalty reward*:\n\n🎁 *{discount}% OFF* on your next visit\n📅 Valid till {validity}\n\nWe truly value your trust and support.\n\n*{business}*`,
  },
  {
    id: 'reengagement',
    label: '💌 We Miss You',
    builtin: true,
    body: `💌 Dear {name},\n\nIt's been a while and we miss you! 😊\n\nWe'd love to welcome you back with a *special returning customer offer*:\n\n✨ *{discount}% OFF* — just for you\n📅 Valid till {validity}\n\nWe hope to see you soon!\n\n*{business}*`,
  },
  {
    id: 'referral',
    label: '🤝 Referral Offer',
    builtin: true,
    body: `🤝 Dear {name},\n\nYou're amazing and so are your friends! 🌟\n\nRefer a friend to *{business}* and both of you get *{discount}% OFF* on your next visit!\n\nSimply ask them to mention your name when they visit.\n\nOffer valid till {validity}.\n\n*{business}*`,
  },
  {
    id: 'thankyou',
    label: '🙏 Thank You',
    builtin: true,
    body: `🙏 Dear {name},\n\nThank you so much for your recent visit to *{business}*! ❤️\n\nWe truly appreciate your support and hope you enjoyed our service.\n\nAs a thank you, here's *{discount}% OFF* on your next visit — valid till {validity}.\n\nSee you again soon!\n\n*{business}*`,
  },
  {
    id: 'event_sale',
    label: '🛍️ Sale / Event Announcement',
    builtin: true,
    body: `🛍️ Dear {name},\n\nBig news! *{business}* is hosting a SPECIAL SALE! 🎉\n\nUp to *{discount}% OFF* on selected items/services.\n\n📅 Offer valid till {validity}\n📍 Visit us in store or call to avail\n\nDon't miss out — limited time offer!\n\n*{business}*`,
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `91${digits}`
  if (digits.length === 12 && digits.startsWith('91')) return digits
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`
  return digits
}

function buildMessage(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`)
}

function waLink(phone: string, message: string): string {
  return `https://wa.me/${normalizePhone(phone)}?text=${encodeURIComponent(message)}`
}

function formatCurrency(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

// ── Edit / Save Modal ─────────────────────────────────────────────────────────

function SaveModal({
  initial,
  onSave,
  onClose,
}: {
  initial: { label: string; body: string }
  onSave:  (label: string, body: string) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(initial.label ? `${initial.label} (copy)` : '')
  const [body,  setBody]  = useState(initial.body)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">Save as Custom Template</h3>
          <button type="button" onClick={onClose} title="Close"><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Template Name</label>
            <input
              autoFocus
              className="input"
              placeholder="e.g. Diwali Offer 2025, Birthday VIP…"
              value={label}
              onChange={e => setLabel(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Message</label>
            <textarea
              rows={8}
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Type your message…"
              className="w-full text-sm border border-gray-200 rounded-lg p-3 resize-none focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button
            type="button"
            onClick={() => onSave(label.trim(), body.trim())}
            disabled={!label.trim() || !body.trim()}
            className="btn-primary flex-1 justify-center bg-green-600 hover:bg-green-700"
          >
            <Save className="w-4 h-4" /> Save Template
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function BroadcastPage() {
  const { branch, tenant } = useAuthStore()
  const businessName = branch?.name ?? tenant?.name ?? 'Our Store'

  // ── State ─────────────────────────────────────────────────────────────────
  const [customTemplates, setCustomTemplates] = useState<Template[]>(loadCustomTemplates)
  const [selected, setSelected]   = useState<Template>(BUILTIN_TEMPLATES[0]!)
  const [messageBody, setMsg]     = useState(BUILTIN_TEMPLATES[0]!.body)
  const [saveModal, setSaveModal] = useState<{ label: string; body: string } | null>(null)
  const [vars, setVars]           = useState({ discount: '20', validity: 'this Sunday', amount: '5000' })

  const [search,     setSearch]     = useState('')
  const [minSpend,   setMinSpend]   = useState(0)
  const [minLoyalty, setMinLoyalty] = useState(0)
  const [checked,    setChecked]    = useState<Set<string>>(new Set())
  const [sent,       setSent]       = useState<Set<string>>(new Set())
  const [showFilter, setShowFilter] = useState(false)

  const allTemplates = [...BUILTIN_TEMPLATES, ...customTemplates]

  // ── Template actions ──────────────────────────────────────────────────────

  function pickTemplate(t: Template) {
    setSelected(t)
    setMsg(t.body)
  }

  function openEditModal(t: Template) {
    setSaveModal({ label: t.label, body: t.body })
  }

  function handleSave(label: string, body: string) {
    const newT: Template = { id: `custom_${Date.now()}`, label, body }
    const updated = [...customTemplates, newT]
    setCustomTemplates(updated)
    saveCustomTemplates(updated)
    setSelected(newT)
    setMsg(body)
    setSaveModal(null)
    toast.success('Template saved!')
  }

  function deleteCustom(id: string) {
    const updated = customTemplates.filter(t => t.id !== id)
    setCustomTemplates(updated)
    saveCustomTemplates(updated)
    if (selected.id === id) { setSelected(BUILTIN_TEMPLATES[0]!); setMsg(BUILTIN_TEMPLATES[0]!.body) }
    toast.success('Template deleted')
  }

  const isCustom = (id: string) => customTemplates.some(t => t.id === id)

  // ── Contacts ──────────────────────────────────────────────────────────────

  const { data, isLoading } = useQuery({
    queryKey: ['broadcast-contacts', minSpend, minLoyalty],
    queryFn:  () => broadcastApi.getContacts({ minSpend, minLoyalty }),
  })

  const allContacts: any[] = data?.contacts ?? []

  const contacts = useMemo(() => {
    if (!search.trim()) return allContacts
    const q = search.toLowerCase()
    return allContacts.filter(c =>
      c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q)
    )
  }, [allContacts, search])

  // ── Selection ─────────────────────────────────────────────────────────────

  const allChecked = contacts.length > 0 && contacts.every(c => checked.has(c.id))

  function toggleAll() {
    setChecked(allChecked ? new Set() : new Set(contacts.map(c => c.id)))
  }

  function toggleOne(id: string) {
    setChecked(prev => {
      const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n
    })
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  function sendTo(contact: any) {
    const msg = buildMessage(messageBody, { ...vars, business: businessName, name: contact.name })
    window.open(waLink(contact.phone, msg), '_blank')
    setSent(prev => new Set([...prev, contact.id]))
  }

  const selectedContacts = contacts.filter(c => checked.has(c.id))
  const pendingSend      = selectedContacts.filter(c => !sent.has(c.id))
  const preview          = buildMessage(messageBody, { ...vars, business: businessName, name: 'Customer' })

  return (
    <div className="p-6 max-w-6xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-lg bg-green-600 flex items-center justify-center">
          <MessageCircle className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-900">WhatsApp Broadcast</h1>
          <p className="text-sm text-gray-500">Send offers and greetings to your customers</p>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-6">

        {/* LEFT: Templates + Composer */}
        <div className="col-span-2 space-y-4">

          {/* Template list */}
          <div className="bg-white border border-gray-100 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Templates</p>
              <button
                type="button"
                onClick={() => setSaveModal({ label: '', body: messageBody })}
                className="text-xs text-green-600 hover:text-green-700 font-medium"
              >
                + Save Current
              </button>
            </div>

            {/* Built-in */}
            <p className="text-xs text-gray-400 mb-1 mt-1">Built-in</p>
            <div className="space-y-0.5 mb-3">
              {BUILTIN_TEMPLATES.map(t => (
                <div key={t.id} className="flex items-center gap-1 group">
                  <button
                    type="button"
                    onClick={() => pickTemplate(t)}
                    className={`flex-1 text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      selected.id === t.id
                        ? 'bg-green-50 text-green-700 font-medium'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {t.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditModal(t)}
                    className="p-1.5 text-gray-300 hover:text-primary-500 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Edit & save as copy"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* Custom */}
            {customTemplates.length > 0 && (
              <>
                <p className="text-xs text-gray-400 mb-1 border-t border-gray-100 pt-2">My Templates</p>
                <div className="space-y-0.5">
                  {customTemplates.map(t => (
                    <div key={t.id} className="flex items-center gap-1 group">
                      <button
                        type="button"
                        onClick={() => pickTemplate(t)}
                        className={`flex-1 text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                          selected.id === t.id
                            ? 'bg-green-50 text-green-700 font-medium'
                            : 'text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {t.label}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditModal(t)}
                        className="p-1.5 text-gray-300 hover:text-primary-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteCustom(t.id)}
                        className="p-1.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Message editor */}
          <div className="bg-white border border-gray-100 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Message</p>
              <button
                type="button"
                onClick={() => setSaveModal({ label: selected.label, body: messageBody })}
                disabled={!messageBody.trim()}
                className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 font-medium disabled:opacity-40"
              >
                <Save className="w-3.5 h-3.5" /> Save as Template
              </button>
            </div>
            <textarea
              rows={9}
              value={messageBody}
              onChange={e => setMsg(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg p-3 resize-none focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="Type your message… Use {name}, {business}, {discount}, {validity}"
            />
            <p className="text-xs text-gray-400 mt-1">
              Variables:{' '}
              {['{name}','{business}','{discount}','{validity}'].map(v => (
                <code key={v} className="bg-gray-100 px-1 rounded mr-1">{v}</code>
              ))}
            </p>
          </div>

          {/* Fill variables */}
          <div className="bg-white border border-gray-100 rounded-xl p-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Fill Variables</p>
            <div className="space-y-2">
              {[
                { key: 'discount', label: 'Discount %' },
                { key: 'validity', label: 'Valid Until' },
                { key: 'amount',   label: 'Min Amount (₹)' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center gap-2">
                  <label className="text-xs text-gray-500 w-28 shrink-0">{label}</label>
                  <input
                    className="input text-sm flex-1"
                    value={(vars as any)[key]}
                    onChange={e => setVars({ ...vars, [key]: e.target.value })}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div className="bg-green-50 border border-green-100 rounded-xl p-4">
            <p className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-2">Preview</p>
            <div className="bg-white rounded-lg p-3 text-sm text-gray-700 whitespace-pre-wrap leading-relaxed shadow-sm max-h-48 overflow-y-auto">
              {preview || <span className="text-gray-400 italic">No message</span>}
            </div>
          </div>
        </div>

        {/* RIGHT: Customer list */}
        <div className="col-span-3 flex flex-col gap-4">

          {/* Search + filter */}
          <div className="bg-white border border-gray-100 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  className="input pl-9 text-sm"
                  placeholder="Search name or phone…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <button
                type="button"
                onClick={() => setShowFilter(f => !f)}
                className="btn-ghost text-sm"
              >
                <Filter className="w-4 h-4" />
                Filter
                {showFilter ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            </div>
            {showFilter && (
              <div className="flex gap-4 pt-3 border-t border-gray-100">
                <div className="flex-1">
                  <label className="text-xs text-gray-500 mb-1 block">Min Total Spend</label>
                  <select className="input text-sm" value={minSpend} onChange={e => setMinSpend(Number(e.target.value))}>
                    <option value={0}>All customers</option>
                    <option value={1000}>₹1,000+</option>
                    <option value={5000}>₹5,000+</option>
                    <option value={10000}>₹10,000+</option>
                    <option value={25000}>₹25,000+</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="text-xs text-gray-500 mb-1 block">Min Loyalty Points</label>
                  <select className="input text-sm" value={minLoyalty} onChange={e => setMinLoyalty(Number(e.target.value))}>
                    <option value={0}>All</option>
                    <option value={100}>100+ pts</option>
                    <option value={500}>500+ pts</option>
                    <option value={1000}>1,000+ pts</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Stats + send bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 text-sm text-gray-500">
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4" />
                {isLoading ? '…' : `${contacts.length} customers`}
              </span>
              {checked.size > 0 && <span className="text-green-700 font-medium">{checked.size} selected</span>}
              {sent.size  > 0 && (
                <span className="text-blue-600 font-medium flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5" /> {sent.size} sent
                </span>
              )}
            </div>
            {pendingSend.length > 0 && (
              <button
                type="button"
                onClick={() => sendTo(pendingSend[0])}
                className="btn-primary bg-green-600 hover:bg-green-700 text-sm"
              >
                <Send className="w-4 h-4" />
                Send Next ({pendingSend.length} left)
              </button>
            )}
            {selectedContacts.length > 0 && pendingSend.length === 0 && (
              <span className="text-sm text-green-600 font-medium flex items-center gap-1">
                <CheckCircle className="w-4 h-4" /> All sent!
              </span>
            )}
          </div>

          {/* Customer table */}
          <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
            {isLoading ? (
              <div className="text-center py-10 text-gray-400">Loading customers…</div>
            ) : contacts.length === 0 ? (
              <div className="text-center py-10 text-gray-400">No customers with phone numbers found.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-2.5 w-8">
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} className="rounded" />
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Customer</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Phone</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Spend</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Pts</th>
                    <th className="px-4 py-2.5 text-center text-xs font-medium text-gray-500">Send</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {contacts.map((c: any) => (
                    <tr key={c.id} className={`hover:bg-gray-50 ${sent.has(c.id) ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-2.5">
                        <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggleOne(c.id)} className="rounded" />
                      </td>
                      <td className="px-4 py-2.5 font-medium text-gray-900">
                        <div className="flex items-center gap-1.5">
                          {c.name}
                          {sent.has(c.id) && <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />}
                        </div>
                        {c.lastPurchase && (
                          <p className="text-xs text-gray-400">Last: {new Date(c.lastPurchase).toLocaleDateString('en-IN')}</p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 font-mono text-xs">{c.phone}</td>
                      <td className="px-4 py-2.5 text-right text-gray-700">
                        {c.totalSpend > 0 ? formatCurrency(c.totalSpend) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-500">{c.loyaltyPts > 0 ? c.loyaltyPts : '—'}</td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          type="button"
                          onClick={() => sendTo(c)}
                          disabled={!messageBody.trim()}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                            sent.has(c.id)
                              ? 'bg-green-100 text-green-700'
                              : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-40'
                          }`}
                        >
                          {sent.has(c.id)
                            ? <><CheckCircle className="w-3 h-3" /> Sent</>
                            : <><MessageCircle className="w-3 h-3" /> Send</>}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="text-xs text-gray-400 text-center">
            Clicking Send opens WhatsApp Web with a pre-filled message. Works with your personal or business WhatsApp.
          </p>
        </div>
      </div>

      {/* Save / Edit Modal */}
      {saveModal && (
        <SaveModal
          initial={saveModal}
          onSave={handleSave}
          onClose={() => setSaveModal(null)}
        />
      )}
    </div>
  )
}
