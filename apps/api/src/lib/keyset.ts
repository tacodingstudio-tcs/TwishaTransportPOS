// Position-based ("keyset") paging for the long lists.
//
// Page numbers make the database walk past every skipped row (page 15,000 of loads took 1.6 s). A cursor is a bookmark instead: the
// sort values of the last row you saw. The next page is "the rows after that one", which the index jumps to directly — the same
// speed on page 1 and page 1,000,000. The browser keeps the cursors it has been given, so Previous is just the cursor before.
//
// A cursor is opaque to the browser (base64url of a small JSON array of strings) and means nothing without the same filters.

import { httpError } from './transport-helpers.js'

export function encodeCursor(parts: Array<string | number>): string {
  return Buffer.from(JSON.stringify(parts.map(String))).toString('base64url')
}

/** Reads a cursor back. `size` = how many sort values it must hold. A tampered or stale marker is a 422, not a crash. */
export function decodeCursor(cursor: string, size: number): string[] {
  try {
    const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(parts) && parts.length === size && parts.every((p) => typeof p === 'string')) return parts as string[]
  } catch { /* fall through */ }
  throw httpError(422, 'That page marker is not valid any more — go back to the first page')
}

/** "(a, b, c) < ($7, $8, $9)" for a list sorted a DESC, b DESC, c DESC. Pushes the values onto `params`. */
export function keysetBefore(params: unknown[], columns: string[], casts: string[], values: string[]): string {
  const marks = values.map((v, i) => { params.push(v); return `$${params.length}::${casts[i]}` })
  return `(${columns.join(', ')}) < (${marks.join(', ')})`
}
