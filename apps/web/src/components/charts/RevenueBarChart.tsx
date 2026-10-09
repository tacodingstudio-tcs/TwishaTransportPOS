// 7-day revenue bar chart for the dashboard
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { format, parseISO } from 'date-fns'

interface DaySummary {
  day:          string
  totalSales:   number
  invoiceCount: number
}

interface Props {
  data:      DaySummary[]
  isLoading: boolean
}

function formatINR(n: number) {
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(1)}L`
  if (n >= 1_000)    return `₹${(n / 1_000).toFixed(1)}K`
  return `₹${n.toFixed(0)}`
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as DaySummary
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-md px-3 py-2 text-xs">
      <div className="font-semibold text-gray-800 mb-1">
        {label ? format(parseISO(label), 'EEE, d MMM') : ''}
      </div>
      <div className="text-primary-700">
        ₹{d.totalSales.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
      </div>
      <div className="text-gray-500">{d.invoiceCount} invoice{d.invoiceCount !== 1 ? 's' : ''}</div>
    </div>
  )
}

export function RevenueBarChart({ data, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="h-48 flex items-center justify-center text-sm text-gray-400">
        Loading chart…
      </div>
    )
  }

  const hasData = data.some((d) => d.totalSales > 0)
  if (!hasData) {
    return (
      <div className="h-48 flex items-center justify-center text-sm text-gray-400">
        No sales in the last 7 days
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={192}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis
          dataKey="day"
          tickFormatter={(v) => format(parseISO(v), 'EEE')}
          tick={{ fontSize: 11, fill: '#9ca3af' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={formatINR}
          tick={{ fontSize: 11, fill: '#9ca3af' }}
          axisLine={false}
          tickLine={false}
          width={48}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f0fdf4' }} />
        <Bar dataKey="totalSales" fill="#22c55e" radius={[4, 4, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  )
}
