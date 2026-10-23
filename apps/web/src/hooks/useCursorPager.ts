// Position-based ("bookmark") paging for long lists — the browser's half of apps/api/src/lib/keyset.ts.
//
// The server returns `nextCursor` (a bookmark to the page after this one). We keep the bookmarks we have been given:
// the trail IS the pages we have walked, so Next pushes one and Previous drops one. Every page is as fast as the first,
// whatever the list's size. The total is only counted for the first page; we remember it for the pages after.
import { useCallback, useState } from 'react'

export function useCursorPager() {
  const [trail, setTrail] = useState<string[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const reset = useCallback(() => { setTrail([]); setTotal(null) }, [])
  const next = useCallback((cursor: string) => setTrail((t) => [...t, cursor]), [])
  const prev = useCallback(() => setTrail((t) => t.slice(0, -1)), [])
  return {
    /** the bookmark to send as `after` (undefined on the first page) */
    after: trail[trail.length - 1] as string | undefined,
    /** 0 on the first page */
    index: trail.length, canPrev: trail.length > 0,
    next, prev, reset,
    /** the list's total, remembered from the first page */
    total, rememberTotal: setTotal,
  }
}

export type CursorPager = ReturnType<typeof useCursorPager>
