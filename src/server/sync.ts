// Server-side sync engine.
//
// Three exported functions consumed by attachWs.ts, ws.ts, hono.ts, and the
// Next.js /api/sync/route.ts template:
//   - pullChanges: returns docs newer than checkpoint, plus a new checkpoint.
//   - pushChanges: writes a batch of client docs, returns server-side conflicts.
//   - streamChanges: opens MongoDB change streams and notifies on every change.
//
// The wire shape is shared with the client sync engines via src/client/sync-types.ts.
//
// Security model — three layers, all enforced here:
//
//   1. Default-deny model allowlist. A model is syncable only if its
//      defineModel() call sets `sync: true` or `sync: {fields: [...]}`. Any
//      pull/push/watch for an unconfigured model throws.
//
//   2. Field-level allowlist. `sync.fields: string[]` projects pulls (server-only
//      fields never reach the client) and strips pushes (clients can't write
//      `role`, audit fields, etc.). Engine fields (_id, updatedAt, createdAt,
//      deletedAt) are always included.
//
//   3. Per-request policy hooks. Callers (attachWs / HTTP route) compute a
//      `filter` (limits which docs pull/watch see) and a `transform` (rewrites
//      each pushed row, e.g. forcing `userId === session.user._id`). Server
//      always owns timestamps — client values are ignored on storage.
//
// Critical invariants:
//   - Pull queries DO NOT filter `deletedAt: null`. Sync must propagate
//     soft-deletes — the client engines look at `_deleted` to apply tombstones.
//   - Models MUST use soft-delete (autoStamp.ts handles this). Hard deletes
//     break change-stream filtering: MongoDB delete events don't carry
//     fullDocument, so a `{$match: {"fullDocument.userId": x}}` pipeline drops
//     them and clients miss tombstones.

import type { Document } from "mongodb"

import DB from "@/db"
import { createStreamHub, type StreamHub } from "./streamHub"
import type { SyncDoc, SyncPushRow } from "@/client/sync-types"
import {
  getClientFields,
  isSyncEnabled,
  isTimeseries,
  CLIENT_ENGINE_FIELDS,
} from "@/runtime/models"

let _sharedHub: StreamHub | null = null
function sharedHub(): StreamHub {
  if (_sharedHub) return _sharedHub
  _sharedHub = createStreamHub({
    openStream: async (dbName, model) => {
      await DB.connect()
      return DB.useDatabase(dbName).model(model).watch([], { fullDocument: "updateLookup" }) as any
    },
  })
  return _sharedHub
}

const EPOCH = 0
const MAX_PUSH_ROWS = 500
const ENGINE_PUSH_FIELDS = new Set<string>([...CLIENT_ENGINE_FIELDS, "_deleted"])

// Per-request policy plumbing. Pull receives `extraFilter` (merged into the
// updatedAt range filter); push receives `transform` (run per row to enforce
// invariants; throw to convert the row into a server-wins conflict).
export type SyncPullOptions = {
  model: string
  checkpoint: number | null
  batchSize?: number
  extraFilter?: Record<string, any>
}

export type SyncPushTransform = (
  doc: any,
  existing: any | null
) => any | Promise<any>

export type SyncPushOptions = {
  model: string
  rows: SyncPushRow[]
  transform?: SyncPushTransform
}

export type SyncStreamSpec = string | { model: string; pipeline?: Document[] }

function parseCheckpoint(checkpoint: number | null): number {
  if (checkpoint == null) return EPOCH
  if (typeof checkpoint === "number" && !isNaN(checkpoint)) return checkpoint
  return EPOCH
}

function pickEffectiveTimestamp(doc: any): number {
  // Retrofit: pre-existing docs without updatedAt fall back to createdAt, then epoch.
  if (typeof doc?.updatedAt === "number") return doc.updatedAt
  if (doc?.updatedAt instanceof Date) return doc.updatedAt.getTime()
  if (doc?.updatedAt) {
    const d = new Date(doc.updatedAt)
    if (!isNaN(d.getTime())) return d.getTime()
  }
  if (typeof doc?.createdAt === "number") return doc.createdAt
  if (doc?.createdAt instanceof Date) return doc.createdAt.getTime()
  if (doc?.createdAt) {
    const d = new Date(doc.createdAt)
    if (!isNaN(d.getTime())) return d.getTime()
  }
  return EPOCH
}

function toMs(d: Date | string | number | null | undefined): number | null {
  if (d == null) return null
  if (typeof d === "number") return isNaN(d) ? null : d
  if (d instanceof Date) return d.getTime()
  const parsed = new Date(d)
  return isNaN(parsed.getTime()) ? null : parsed.getTime()
}

function toSyncDoc(doc: any): SyncDoc {
  const effective = pickEffectiveTimestamp(doc)
  const _id = doc._id != null ? String(doc._id) : ""
  const updatedAt = effective
  const deletedAt = toMs(doc.deletedAt)
  const out: SyncDoc = {
    ...doc,
    _id,
    updatedAt,
    deletedAt,
    _deleted: !!deletedAt,
  }
  if (doc.createdAt != null) (out as any).createdAt = toMs(doc.createdAt) ?? doc.createdAt
  return out
}

function requireSyncEnabled(model: string): void {
  if (isTimeseries(model)) {
    throw new Error(
      `Model "${model}" is a time-series collection. Sync is not supported on time-series models — they have restricted update semantics and cannot carry soft-delete tombstones.`
    )
  }
  if (!isSyncEnabled(model)) {
    throw new Error(
      `Model "${model}" is not configured for sync. Pass \`sync: true\` to defineModel() options.`
    )
  }
}

function buildProjection(model: string): Record<string, 1> | undefined {
  const fields = getClientFields(model)
  if (!fields) return undefined
  const projection: Record<string, 1> = {}
  for (const f of CLIENT_ENGINE_FIELDS) projection[f] = 1
  for (const f of fields) projection[f] = 1
  return projection
}

function stripToAllowed(doc: any, model: string): any {
  const fields = getClientFields(model)
  if (!fields) return { ...doc }
  const allowed = new Set<string>(fields)
  const out: any = {}
  for (const k of Object.keys(doc)) {
    if (allowed.has(k) || ENGINE_PUSH_FIELDS.has(k)) out[k] = doc[k]
  }
  return out
}

function combineFilter(
  tsFilter: Record<string, any>,
  extra: Record<string, any> | undefined
): Record<string, any> {
  if (!extra || Object.keys(extra).length === 0) return tsFilter
  if (Object.keys(tsFilter).length === 0) return extra
  return { $and: [tsFilter, extra] }
}

export async function pullChanges(args: SyncPullOptions): Promise<{
  documents: SyncDoc[]
  checkpoint: number | null
}> {
  const { model, checkpoint, extraFilter } = args
  requireSyncEnabled(model)
  const batchSize = Math.max(1, Math.min(args.batchSize ?? 200, 1000))

  await DB.connect()
  const collection = DB.model(model)
  const since = parseCheckpoint(checkpoint)

  // Pull anything modified after `since`. We DO NOT filter on deletedAt:null —
  // tombstones must propagate. updatedAt is auto-stamped on every write
  // including soft-deletes (see autoStamp.ts).
  const tsFilter = since === 0
    ? {}
    : {
        $or: [
          { updatedAt: { $gt: since } },
          // Retrofit branch — for docs without updatedAt, fall back to createdAt.
          { updatedAt: { $exists: false }, createdAt: { $gt: since } },
        ],
      }

  const filter = combineFilter(tsFilter, extraFilter)
  const projection = buildProjection(model)

  const cursor = collection.find(filter)
  if (projection) cursor.project(projection)

  const docs = await cursor
    .sort({ updatedAt: 1, createdAt: 1 })
    .limit(batchSize)
    .toArray()

  const documents = docs.map(toSyncDoc)
  const lastTs = documents.length
    ? documents[documents.length - 1].updatedAt
    : checkpoint

  return { documents, checkpoint: lastTs }
}

export async function pushChanges(args: SyncPushOptions): Promise<{
  conflicts: SyncDoc[]
}> {
  const { model, transform } = args
  requireSyncEnabled(model)

  // Cap batch size to bound work-per-request. Reject the entire batch (rather
  // than silently truncating) so the client knows to reduce its push size.
  const incomingRows = Array.isArray(args.rows) ? args.rows : []
  if (incomingRows.length > MAX_PUSH_ROWS) {
    throw new Error(`Push batch exceeds ${MAX_PUSH_ROWS} rows`)
  }

  await DB.connect()
  const collection = DB.model(model)

  const conflicts: SyncDoc[] = []

  for (const row of incomingRows) {
    const incoming = row.newDocumentState
    if (!incoming || typeof incoming._id !== "string" || !incoming._id) continue
    const _id = incoming._id
    const existing = await collection.findOne({ _id: _id as any })

    // Conflict detection runs against the RAW client doc — we trust client
    // updatedAt only for ordering, never for storage. Server-stamps below.
    if (existing) {
      const existingTs = pickEffectiveTimestamp(existing)
      if (row.assumedMasterState) {
        const assumedTs = pickEffectiveTimestamp(row.assumedMasterState)
        if (existingTs > assumedTs) {
          conflicts.push(toSyncDoc(existing))
          continue
        }
      } else {
        // No optimistic-concurrency token from the client (e.g. WatermelonDB
        // adapter). Fall back to plain last-writer-wins by client clock.
        const incomingTs = pickEffectiveTimestamp(incoming)
        if (existingTs > incomingTs) {
          conflicts.push(toSyncDoc(existing))
          continue
        }
      }
    }

    // Strip → transform → strip-again. The double strip is defensive: a
    // transform that re-injects a server-only field would otherwise leak into
    // the merge below.
    let next = stripToAllowed(incoming, model)
    if (transform) {
      try {
        const result = await transform(next, existing)
        next = result ?? next
      } catch {
        // Treat policy rejection as a conflict — surface server's existing
        // version so the client doesn't silently lose the local edit.
        if (existing) conflicts.push(toSyncDoc(existing))
        continue
      }
      next = stripToAllowed(next, model)
    }

    // Server owns timestamps. Storage values come from server clock, never
    // from the client — even if the client lied about updatedAt to win
    // conflict detection above, persisted values are always authoritative.
    const now = Date.now()
    const isTombstone = !!incoming._deleted || incoming.deletedAt != null
    const existingCreatedAt = toMs((existing as any)?.createdAt)
    const existingDeletedAt = toMs((existing as any)?.deletedAt)

    next._id = _id
    next.updatedAt = now
    next.createdAt = existingCreatedAt ?? now
    next.deletedAt = isTombstone ? (existingDeletedAt ?? now) : null
    delete next._deleted

    if (existing) {
      // $set merge preserves server-only fields on existing doc that the
      // client wasn't allowed to send.
      const { _id: _omit, ...overlay } = next
      await collection.updateOne({ _id: _id as any }, { $set: overlay })
    } else {
      await collection.insertOne(next)
    }
  }

  return { conflicts }
}

// Translate a find-style filter on top-level fields into a change-stream
// $match pipeline. `{userId: "bob"}` becomes `{$match: {"fullDocument.userId": "bob"}}`.
// Operators ($and, $or, $eq, $in, etc.) at the top level are passed through
// rewrapped under fullDocument.<field>; complex expressions should be supplied
// via a pre-built `pipeline` on the spec object.
export function filterToWatchPipeline(filter: Record<string, any>): Document[] {
  if (!filter || Object.keys(filter).length === 0) return []
  const match: Record<string, any> = {}
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("$")) {
      match[key] = value
    } else {
      match[`fullDocument.${key}`] = value
    }
  }
  return [{ $match: match }]
}

export function streamChanges(
  specs: SyncStreamSpec[],
  onEvent: (model: string) => void
): () => void {
  let cancelled = false
  const unsubs: (() => Promise<void>)[] = []

  // Connect lazily so callers don't have to await.
  ;(async () => {
    try {
      await DB.connect()
      if (cancelled) return
      for (const spec of specs) {
        if (cancelled) return
        const model = typeof spec === "string" ? spec : spec.model
        if (isTimeseries(model)) {
          console.warn(`[mogobase/sync] streamChanges skipped for "${model}": time-series collections are not supported by sync.`)
          continue
        }
        // Legacy pipeline specs don't carry a structured filter — fall back to
        // an unfiltered hub subscription (matches all docs for that model).
        // The primary new path in attachWs.ts subscribes via hub.subscribe
        // directly and never calls streamChanges anymore.
        //
        // The DEFAULT database, explicitly: sync is documented as bound to MONGO_DB
        // (multi-tenant sync is not supported), and this legacy path has no request to
        // resolve one from. Naming it beats inheriting whatever the hub keyed first.
        try {
          const unsub = await sharedHub().subscribe(DB.db.databaseName, model, undefined, () => onEvent(model))
          // Caller may have invoked the cleanup fn between the await above and
          // this push. If so, the cleanup-path already iterated `unsubs`, so
          // unwind this subscription inline rather than orphaning it.
          if (cancelled) {
            unsub().catch(() => {})
            return
          }
          unsubs.push(unsub)
        } catch (err) {
          console.warn(`[mogobase/sync] streamChanges hub.subscribe failed for ${model}:`, err)
        }
      }
    } catch (err) {
      console.warn("[mogobase/sync] streamChanges init failed:", err)
    }
  })()

  return () => {
    cancelled = true
    for (const u of unsubs) { u().catch(() => {}) }
  }
}

// Public policy types — consumed by attachWs / hono / HTTP route templates.
export type SyncOperation = "pull" | "push" | "watch"

export type SyncPolicyContext = {
  op: SyncOperation
  model: string
  headers: any
}

export type SyncPolicyDecision = {
  allow: boolean
  filter?: Record<string, any>
  transform?: SyncPushTransform
}

export type SyncPolicy = (
  ctx: SyncPolicyContext
) => SyncPolicyDecision | Promise<SyncPolicyDecision>
