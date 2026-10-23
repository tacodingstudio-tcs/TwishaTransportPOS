// The credit / debit notes raised against a bill, listed under it.
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { transportApi } from '@/lib/api'
import { inr, fmtDate } from '@/components/transport/format'

interface NoteRow { id: string; number: string; txnType: string; date: string; grandTotal: number; paidAmt: number; status: string; reason: string | null }

export function BillNotes({ billId }: { billId: string }) {
  const { data = [] } = useQuery<NoteRow[]>({ queryKey: ['bill-notes', billId], queryFn: () => transportApi.billNotes(billId) })
  if (data.length === 0) return null
  const live = data.filter((n) => n.status !== 'cancelled')
  const net = live.reduce((t, n) => t + (n.txnType === 'credit_note' ? -n.grandTotal : n.grandTotal), 0)
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-900">Credit and debit notes against this bill</h3>
        <span className={`text-xs font-semibold ${net < 0 ? 'text-red-600' : 'text-green-700'}`}>Net {net < 0 ? '−' : '+'}{inr(Math.abs(net), 2)}</span>
      </div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-gray-50">
          {data.map((n) => (
            <tr key={n.id} className={n.status === 'cancelled' ? 'opacity-50' : ''}>
              <td className="py-1.5"><Link to={`/invoices/${n.id}`} className="font-mono text-xs text-primary-600 hover:underline">{n.number}</Link></td>
              <td className="py-1.5 text-xs">{n.txnType === 'credit_note' ? <span className="text-red-600 font-medium">Credit</span> : <span className="text-green-700 font-medium">Debit</span>}</td>
              <td className="py-1.5 text-gray-600">{n.reason ?? ''}</td>
              <td className="py-1.5 text-xs text-gray-500">{fmtDate(n.date)}</td>
              <td className="py-1.5 text-right tabular-nums">{n.txnType === 'credit_note' ? '−' : ''}{inr(n.grandTotal, 2)}</td>
              <td className="py-1.5 text-right text-xs text-gray-400">{n.status === 'cancelled' ? 'cancelled' : n.txnType === 'debit_note' && n.paidAmt >= n.grandTotal - 0.01 ? 'paid' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
