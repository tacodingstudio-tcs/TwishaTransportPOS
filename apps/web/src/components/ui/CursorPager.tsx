// Previous / Next for a position-based list: "21–40 of 15,000". See hooks/useCursorPager.ts.
import type { CursorPager as Pager } from '@/hooks/useCursorPager'

export function CursorPager({ pager, pageSize, shown, nextCursor, total }: {
  pager: Pager; pageSize: number; shown: number; nextCursor?: string | null; total?: number | null
}) {
  if (!pager.canPrev && !nextCursor) return null                 // everything fits on one page
  const from = pager.index * pageSize + 1
  const count = total ?? pager.total
  return (
    <div className="flex items-center justify-center gap-3">
      <button type="button" className="btn-ghost text-sm" disabled={!pager.canPrev} onClick={pager.prev}>← Previous</button>
      <span className="text-sm text-gray-500 tabular-nums">
        {shown === 0 ? 'No more' : `${from.toLocaleString('en-IN')}–${(from + shown - 1).toLocaleString('en-IN')}`}{count != null ? ` of ${count.toLocaleString('en-IN')}` : ''}
      </span>
      <button type="button" className="btn-ghost text-sm" disabled={!nextCursor} onClick={() => nextCursor && pager.next(nextCursor)}>Next →</button>
    </div>
  )
}
