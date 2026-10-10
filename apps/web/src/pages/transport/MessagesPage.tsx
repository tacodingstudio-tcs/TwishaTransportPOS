// WhatsApp messages: what the system has sent / failed to send, and which automatic messages are on.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { RefreshCw, Send, Paperclip } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { fmtDateTime } from '@/components/transport/format'

const KIND_LABEL: Record<string, string> = {
  lr_booked: 'Load booked', lr_delivered: 'Load delivered', bill_created: 'Bill sent',
  bill_reminder: 'Payment reminder', compliance_expiry: 'Daily alerts (owner)', eway_expiring: 'E-way expiring', manual: 'Manual',
}

const STATUS_STYLE: Record<string, string> = {
  sent: 'bg-green-50 text-green-700', queued: 'bg-blue-50 text-blue-700',
  failed: 'bg-red-50 text-red-700', skipped: 'bg-gray-100 text-gray-600',
}

const SWITCHES: Array<{ key: string; title: string; text: string }> = [
  { key: 'notify_lr_booked', title: 'Load booked', text: 'Send the LR copy (PDF) to the sender when a load is booked.' },
  { key: 'notify_lr_delivered', title: 'Load delivered', text: 'Tell the sender when the goods are delivered.' },
  { key: 'notify_bill_created', title: 'Bill made', text: 'Send the freight bill (PDF) to the party when you make a bill.' },
  { key: 'notify_bill_reminders', title: 'Payment reminders', text: 'Remind parties about overdue bills, automatically, every few days.' },
  { key: 'notify_owner_alerts', title: 'Daily alerts for me', text: 'Every morning, a message to the owner with papers and e-way bills about to expire.' },
]

export function MessagesPage() {
  const qc = useQueryClient()
  const canManage = useAuthStore((s) => s.canManage())
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)

  const { data: settings } = useQuery({ queryKey: ['transport-notify-settings'], queryFn: transportApi.notifySettings })
  const { data: log, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['transport-notifications', status, page],
    queryFn: () => transportApi.notifications({ status: status || undefined, page, limit: 25 }),
    refetchInterval: 15_000,
  })

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => transportApi.saveNotifySettings(patch),
    onSuccess: (s) => { qc.setQueryData(['transport-notify-settings'], s); toast.success('Saved') },
    onError: (e) => toast.error(apiError(e)),
  })
  const retry = useMutation({
    mutationFn: (id: string) => transportApi.retryNotification(id),
    onSuccess: () => { toast.success('Queued again'); qc.invalidateQueries({ queryKey: ['transport-notifications'] }) },
    onError: (e) => toast.error(apiError(e)),
  })
  const runNow = useMutation({
    mutationFn: transportApi.runAlerts,
    onSuccess: (r: any) => {
      toast.success(`${r.reminders} reminder(s) and ${r.ownerAlerts} alert line(s) queued`)
      qc.invalidateQueries({ queryKey: ['transport-notifications'] })
    },
    onError: (e) => toast.error(apiError(e)),
  })

  const rows: any[] = log?.data ?? []
  const totalPages = Math.max(1, Math.ceil((log?.total ?? 0) / 25))

  return (
    <div>
      <PageHeader title="WhatsApp messages" subtitle="Automatic messages to parties and to you — and whether they were delivered" />
      <div className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">

        {/* Switches */}
        <section className="card p-5 xl:col-span-1 h-fit">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Automatic messages</h2>
          <p className="text-xs text-gray-500 mb-4">Everything is off until you switch it on. You can always send a message by hand from a load or a bill.</p>
          <ul className="space-y-4">
            {SWITCHES.map((s) => (
              <li key={s.key} className="flex items-start gap-3">
                <input
                  id={s.key} type="checkbox" className="mt-1 h-4 w-4"
                  disabled={!canManage || save.isPending || !settings}
                  checked={!!settings?.[s.key]}
                  onChange={(e) => save.mutate({ [s.key]: e.target.checked })}
                />
                <label htmlFor={s.key} className="cursor-pointer">
                  <div className="text-sm font-medium text-gray-900">{s.title}</div>
                  <div className="text-xs text-gray-500">{s.text}</div>
                </label>
              </li>
            ))}
          </ul>

          {settings && (
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="rem-days">Remind every (days)</label>
                <input id="rem-days" type="number" min={1} max={60} className="input" disabled={!canManage}
                  defaultValue={settings.notify_reminder_every_days}
                  onBlur={(e) => { const v = Number(e.target.value); if (v >= 1 && v <= 60 && v !== settings.notify_reminder_every_days) save.mutate({ notify_reminder_every_days: v }) }} />
              </div>
              <div>
                <label className="label" htmlFor="own-phone">My WhatsApp number</label>
                <input id="own-phone" className="input" disabled={!canManage} placeholder="business phone"
                  defaultValue={settings.notify_owner_phone ?? ''}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== (settings.notify_owner_phone ?? '')) save.mutate({ notify_owner_phone: v || null }) }} />
              </div>
            </div>
          )}

          {canManage && (
            <button type="button" className="btn-ghost border border-gray-200 mt-5 w-full justify-center" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
              <Send className="w-4 h-4" /> Run today's reminders now
            </button>
          )}
        </section>

        {/* Log */}
        <section className="card xl:col-span-2 overflow-hidden">
          <div className="flex items-center justify-between gap-3 p-4 border-b border-gray-100">
            <select className="input max-w-[200px]" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="Filter by status">
              <option value="">All messages</option>
              <option value="sent">Sent</option><option value="queued">Waiting</option>
              <option value="failed">Failed</option><option value="skipped">Not sent</option>
            </select>
            <button type="button" className="btn-ghost" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>

          {isLoading ? <p className="p-8 text-center text-gray-400">Loading…</p>
            : rows.length === 0 ? <p className="p-8 text-center text-gray-400 text-sm">No messages yet.</p>
            : (
              <ul className="divide-y divide-gray-100">
                {rows.map((n) => (
                  <li key={n.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 flex items-center gap-2 flex-wrap">
                          {KIND_LABEL[n.kind] ?? n.kind}
                          <span className="text-gray-400 font-normal">→ {n.recipientName || n.toPhone}</span>
                          {n.attachment && <Paperclip className="w-3.5 h-3.5 text-gray-400" aria-label="PDF attached" />}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">{n.toPhone} · {fmtDateTime(n.createdAt)}</div>
                        <p className="text-xs text-gray-600 mt-2 whitespace-pre-line line-clamp-3">{n.message}</p>
                        {n.error && <p className="text-xs text-red-600 mt-1">{n.error}</p>}
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        <span className={`badge ${STATUS_STYLE[n.status] ?? ''}`}>{n.status === 'queued' ? 'waiting' : n.status === 'skipped' ? 'not sent' : n.status}</span>
                        {!readOnly && (n.status === 'failed' || n.status === 'skipped') && (
                          <button type="button" className="text-xs text-primary-600 hover:underline" disabled={retry.isPending} onClick={() => retry.mutate(n.id)}>Try again</button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between p-3 border-t border-gray-100 text-sm">
              <button type="button" className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span className="text-gray-500">Page {page} of {totalPages}</span>
              <button type="button" className="btn-ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
