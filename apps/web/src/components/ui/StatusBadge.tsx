// src/components/ui/StatusBadge.tsx
const STATUS_STYLES: Record<string, string> = {
  draft:      'bg-gray-100 text-gray-600',
  confirmed:  'bg-blue-100 text-blue-700',
  paid:       'bg-green-100 text-green-700',
  partial:    'bg-amber-100 text-amber-700',
  cancelled:  'bg-red-100 text-red-700',
}

const STATUS_LABELS: Record<string, string> = {
  draft:      'Draft',
  confirmed:  'Confirmed',
  paid:       'Paid',
  partial:    'Partially paid',
  cancelled:  'Cancelled',
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}
