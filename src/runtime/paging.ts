// Browser-safe polyfill for `mongo-cursor-pagination`'s default export.
// Same API shape — `MongoPaging.find(collection, params)` — so a sync-mode
// handler can dispatch on `isServer()` and use the upstream package on the
// server, this polyfill on the client:
//
//   import { isServer, MongoPaging as MongoPagingPolyfill } from "mogobase/runtime"
//   import MongoPaging from "mongo-cursor-pagination"
//   const Pager = isServer() ? MongoPaging : MongoPagingPolyfill
//   const result = await Pager.find(ctx.db.model(name), { query, ...paginationOpts })
//
// The polyfill operates on any object exposing `find(filter).toArray()` —
// matching `RxMongoAdapter` and `WatermelonMongoAdapter`. It pulls the full
// matched set, then sorts/filters/slices in JS. Adequate for the small
// per-user datasets typical in offline / sync-mode flows; not a substitute
// for real cursor-based queries against a server-side Mongo collection.
//
// Cursor tokens are base64url(JSON.stringify(value)) — opaque, with a stable
// shape (`_id` cursor → encoded value; non-`_id` cursor → `[fieldValue, _id]`).

export type PagingParams = {
  query?: any
  paginatedField?: string
  limit: number
  sortAscending?: boolean
  sortCaseInsensitive?: boolean
  previous?: string
  next?: string
  fields?: Record<string, 0 | 1>
}

export type PagingResult<T = any> = {
  results: T[]
  previous: string | null
  next: string | null
  hasPrevious: boolean
  hasNext: boolean
}

type FindableCollection<T = any> = {
  find: (filter: any) => { toArray: () => Promise<T[]> }
}

function urlSafeBase64Encode(s: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  }
  // Browser path: encode UTF-8 bytes via TextEncoder so non-ASCII strings round-trip.
  const bytes = new TextEncoder().encode(s)
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function urlSafeBase64Decode(s: string): string {
  let padded = s.replace(/-/g, "+").replace(/_/g, "/")
  while (padded.length % 4) padded += "="
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf-8")
  }
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function encodeCursor(v: any): string {
  return urlSafeBase64Encode(JSON.stringify(v))
}

function decodeCursor(s: string): any {
  return JSON.parse(urlSafeBase64Decode(s))
}

function valueOf(doc: any, path: string): any {
  if (!doc || path === "_id") return doc?._id
  if (!path.includes(".")) return (doc as any)[path]
  return path.split(".").reduce((acc: any, k: string) => (acc == null ? acc : acc[k]), doc)
}

function compareValues(a: any, b: any): number {
  if (a === b) return 0
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1
  return String(a) < String(b) ? -1 : 1
}

function makeCursor(doc: any, paginatedField: string, sortCaseInsensitive?: boolean): string {
  if (paginatedField === "_id") return encodeCursor(doc._id)
  let v = valueOf(doc, paginatedField)
  if (sortCaseInsensitive && typeof v === "string") v = v.toLowerCase()
  return encodeCursor([v, doc._id])
}

function projectFields(doc: any, fields: Record<string, 0 | 1>): any {
  const keys = Object.keys(fields)
  const includes = keys.filter((k) => fields[k] === 1)
  const excludes = keys.filter((k) => fields[k] === 0)
  if (includes.length > 0) {
    const out: any = {}
    if (fields._id !== 0) out._id = doc._id
    for (const k of includes) out[k] = doc[k]
    return out
  }
  if (excludes.length > 0) {
    const out = { ...doc }
    for (const k of excludes) delete out[k]
    return out
  }
  return doc
}

async function find<T = any>(
  col: FindableCollection<T>,
  params: PagingParams
): Promise<PagingResult<T>> {
  const limit = Math.max(1, params.limit | 0)
  const paginatedField = params.paginatedField || "_id"
  const sortAscending = !!params.sortAscending
  const reverse = !!params.previous
  // Going to "previous" reverses the natural sort.
  const dir = sortAscending !== reverse ? 1 : -1
  const sortCI = !!params.sortCaseInsensitive

  const all: any[] = (await col.find(params.query || {}).toArray()) as any[]

  all.sort((a, b) => {
    if (paginatedField === "_id") {
      return compareValues(a._id, b._id) * dir
    }
    let av = valueOf(a, paginatedField)
    let bv = valueOf(b, paginatedField)
    if (sortCI) {
      if (typeof av === "string") av = av.toLowerCase()
      if (typeof bv === "string") bv = bv.toLowerCase()
    }
    const primary = compareValues(av, bv)
    if (primary !== 0) return primary * dir
    return compareValues(a._id, b._id) * dir
  })

  const cursorRaw = params.next ?? params.previous ?? null
  let docs = all
  if (cursorRaw) {
    try {
      const decoded = decodeCursor(cursorRaw)
      docs = all.filter((doc: any) => {
        if (paginatedField === "_id") {
          return compareValues(doc._id, decoded) * dir > 0
        }
        const [fieldValue, idValue] = Array.isArray(decoded) ? decoded : [decoded, undefined]
        let dv = valueOf(doc, paginatedField)
        if (sortCI && typeof dv === "string") dv = dv.toLowerCase()
        const primary = compareValues(dv, fieldValue) * dir
        if (primary !== 0) return primary > 0
        if (idValue === undefined) return false
        return compareValues(doc._id, idValue) * dir > 0
      })
    } catch {
      // Bad cursor — fall back to first page.
    }
  }

  // Take limit+1 to detect "has more".
  const slice = docs.slice(0, limit + 1)
  const hasMore = slice.length > limit
  if (hasMore) slice.pop()

  // Mirror upstream `prepareResponse` semantics.
  const hasPrevious = !!params.next || !!(params.previous && hasMore)
  const hasNext = !!params.previous || hasMore
  const ordered = reverse ? slice.slice().reverse() : slice

  const first = ordered[0]
  const last = ordered[ordered.length - 1]

  const projected = params.fields ? ordered.map((d) => projectFields(d, params.fields!)) : ordered

  return {
    results: projected as T[],
    previous: first ? makeCursor(first, paginatedField, sortCI) : null,
    hasPrevious,
    next: last ? makeCursor(last, paginatedField, sortCI) : null,
    hasNext,
  }
}

export const MongoPaging = { find }
export default MongoPaging
