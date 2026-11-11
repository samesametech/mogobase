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

import { copyHeaders } from "./headers"
import type { Collection, Document } from "mongodb"

import DB from "@/db"
import { createStreamHub, onChangeOrResync, type StreamHub } from "./streamHub"
import { prefixFilterWithFullDocument, routeWatchInput } from "./watchInput"
import { backoffDelay, STABLE_LIFE_MS } from "./backoff"
import { openChangeStreamWatch, openHubStream, streamStarted, warnOwnStream, warnUnnarrowed } from "./changeStreamWatch"
import type { OpenWatch } from "./liveQuery"
import type { SyncDoc, SyncPushRow } from "@/client/sync-types"
import {
  getClientFields,
  isSyncEnabled,
  isTimeseries,
  latestModelDef,
  CLIENT_ENGINE_FIELDS,
} from "@/runtime/models"

let _sharedHub: StreamHub | null = null
/** The hub sync streams of the legacy transport and streamChanges share. */
export function syncHub(): StreamHub {
  if (_sharedHub) return _sharedHub
  _sharedHub = createStreamHub({
    // A subscribe resolves once its stream runs, as on attachWs's hub (see streamStarted).
    whenReady: (stream) => streamStarted(stream as any),
    openStream: openHubStream,
  })
  return _sharedHub
}

const EPOCH = 0
// Rows a pull cannot page past a first pull: a string updatedAt, no updatedAt with a createdAt
// that is not a number, or no timestamp at all (an import's or a migration's) — page key 0
// (pageKey), which only a pull from the start offers. Each branch is a positive bracket, an index
// range: a `$not` branch examined every row with no updatedAt, numeric createdAt and all — a
// retrofitted collection was scanned every minute, for ever, since nothing was found.
const UNPAGEABLE = {
  $or: [
    // A numeric stamp of 0 or below (a backfill's "epoch" default) has page key 0 too.
    { updatedAt: { $lte: 0 } },
    { updatedAt: null, createdAt: { $lte: 0 } },
    { updatedAt: { $type: "string" } },
    { updatedAt: null, createdAt: null },
    { updatedAt: null, createdAt: { $type: "string" } },
    { updatedAt: null, createdAt: { $type: "date" } },
  ],
}
const UNPAGEABLE_PROBE_MS = 60_000
const unpageableProbes = new Map<string, number>()
const warnedUnpageable = new Set<string>()

/** Test hook: forget when each model was last probed for rows a pull cannot page. */
export function _resetUnpageableProbe(): void {
  unpageableProbes.clear()
  warnedUnpageable.clear()
}

// Checked at most once a minute per model, off the pull's path; said once per model. The fix it
// gives stamps them with the time of the fix — stamped with their own old date, a client whose
// checkpoint is past it never pulled them — in chunks (see the sync guide).
function probeUnpageable(collection: Collection, model: string): void {
  if (warnedUnpageable.has(model) || Date.now() - (unpageableProbes.get(model) ?? -Infinity) < UNPAGEABLE_PROBE_MS) return
  unpageableProbes.set(model, Date.now())
  collection
    .findOne(UNPAGEABLE, { projection: { _id: 1 } })
    .then((row) => {
      if (!row || warnedUnpageable.has(model)) return
      warnedUnpageable.add(model)
      console.warn(
        `[mogobase/sync] ${model} has rows sync cannot page (a string updatedAt, a createdAt that is not a number with no ` +
          `updatedAt, or no timestamp at all — an import's): only a client's first pull may get them. Stamp them with the ` +
          `time of the fix (MongoDB 4.2+): db.${model}.updateMany({ updatedAt: { $not: { $type: "number" } } }, ` +
          `[{ $set: { updatedAt: { $toLong: "$$NOW" } } }]) — in chunks on a large collection: see the sync guide.`
      )
    })
    .catch(() => {})
}

// The furthest a Date reaches, either way: new Date(ms) past it is invalid, and a Date read built
// from it answered every Date-stamped row again, with an older checkpoint — a ping-pong.
const MAX_DATE_MS = 8.64e15
const dateOf = (ms: number): Date | undefined => (Math.abs(ms) <= MAX_DATE_MS ? new Date(ms) : undefined)

/**
 * What a pull orders, completes and checkpoints a row by: exactly what its reads select and sort
 * on — a numeric updatedAt (a BSON number too), a Date updatedAt, else (none) a numeric createdAt;
 * else 0, which only a pull from the start offers (a string updatedAt, a Date or string createdAt
 * with none, no stamp at all). Ordered by pickEffectiveTimestamp instead, a row no read selects
 * had a place in the order and the checkpoint, and main's first pull returned rows this did not.
 * The wire's updatedAt is still pickEffectiveTimestamp's.
 */
function pageKey(doc: any): number {
  const updated = doc?.updatedAt
  let key = numberOf(updated)
  if (key === undefined && updated instanceof Date) key = updated.getTime()
  if (key === undefined && updated == null) key = numberOf(doc?.createdAt)
  return key !== undefined && Number.isFinite(key) ? key : 0
}
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

/** Request headers in the one shape the resolver and the sync policy get from every door. */
export { headerView, type HeaderView } from "./headers"

/**
 * The policy's decision for one operation, asked the same way by every door — both WebSocket
 * transports, hono.ts's /api/sync and the sync route template: headers as a headerView, and a
 * policy that throws (its session store down) is a logged refusal. The HTTP routes used to call
 * the policy themselves, so a throw there answered 400 with the error's own text.
 * No policy: allowed.
 */
export async function evaluateSyncPolicy(
  policy: SyncPolicy | undefined,
  op: "pull" | "push" | "watch",
  model: string,
  headers: unknown
): Promise<SyncPolicyDecision> {
  if (!policy) return { allow: true }
  try {
    const decision = await policy({ op, model, headers: copyHeaders(headers) }) // its own: a write stays with this call
    // A policy that returns nothing (a fallthrough with no return) or anything but a decision is
    // a refusal: read as one, `decision.allow` threw at every caller — a 400 carrying a TypeError
    // over HTTP, a sync-subscribe retried for the socket's whole life.
    if (!decision || typeof decision !== "object") {
      console.warn(`[mogobase/sync] policy returned ${String(decision)} for ${op} ${model} — denied; return { allow: true | false }`)
      return { allow: false }
    }
    return decision
  } catch (err) {
    console.warn(`[mogobase/sync] policy threw for ${op} ${model}:`, err)
    const denied = { allow: false }
    threwDecisions.add(denied)
    return denied
  }
}

// The refusals that came from a throw — a session store down for a moment — which a long-lived
// sync-subscribe asks again (syncSubscribe), where an allow: false is the policy's answer.
const threwDecisions = new WeakSet<object>()

/** @internal Whether a refusal from evaluateSyncPolicy came from the policy throwing. */
export function policyThrew(decision: SyncPolicyDecision): boolean {
  return threwDecisions.has(decision)
}

/**
 * A model to stream, with what narrows it: `filter`, the sync policy's bare doc-filter (the
 * same one pull applies), or a change-stream `pipeline`. A string streams every change.
 */
export type SyncStreamSpec = string | { model: string; pipeline?: Document[]; filter?: Record<string, any> }

/**
 * The change-event $match for a sync policy's filter: on the document, and nothing else. Not
 * OR'd with every delete, as a live query's is: sync deletes are soft (an update the filter
 * matches), and a hard delete carries no document to tell its tenant by — OR'd in, every
 * tenant's clients heard of it and pulled, for nothing (a pull never returns a hard-deleted row).
 *
 * A filter using an operator no change stream runs ($where, $text, $near) is kept: routeWatchInput
 * (subscribeSyncStream) then leaves the stream unnarrowed, with a warning once per (model,
 * operator). Unnarrowed loses no secrecy: a sync-stream frame names the model only, and each pull
 * still applies the whole filter — it costs pulls that find nothing.
 */
export function syncChangeMatch(filter: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!filter || !Object.keys(filter).length) return undefined
  // Field paths inside an `$expr` move too: written for the rows pull reads, read off the change
  // event they named nothing, so a policy filtering with $expr streamed no change at all.
  return prefixFilterWithFullDocument(filter, true)
}

/**
 * Subscribe a sync stream for `model` in `dbName`, narrowed by `match` (a change-event $match:
 * the policy's filter) AND `pipeline` — on `hub` when routeWatchInput says its JS matcher can
 * run it, else on a change stream of its own, where MongoDB does ($elemMatch, $expr, …, or a
 * stage other than $match).
 *
 * Default-deny, like pull and push: a model not declared `sync: true` (or a time-series one)
 * throws here. The watch path used to check only the policy, so with no policy — the default
 * — any client could subscribe to any collection and hear of every write to it.
 */
export async function subscribeSyncStream(
  hub: StreamHub,
  dbName: string,
  model: string,
  onEvent: () => void,
  narrow: { match?: Record<string, any>; pipeline?: Document[] } = {}
): Promise<() => Promise<void>> {
  requireSyncEnabled(model)
  // Both narrow it: the policy's filter is never dropped for the pipeline (or the reverse).
  const stages: Document[] = [...(narrow.match ? [{ $match: narrow.match }] : []), ...(narrow.pipeline ?? [])]
  const route = routeWatchInput(stages)
  if (route.kind === "hub" && route.unnarrowed) warnUnnarrowed(dbName, model, route.unnarrowed, "sync stream")
  // A change or a "resync" makes the client pull; "error" is the hub saying it is still
  // reconnecting (see SubscriberCallback) — a pull then reads nothing new.
  if (route.kind === "hub") return hub.subscribe(dbName, model, route.matchFilter, onChangeOrResync(onEvent))
  warnOwnStream(dbName, model, route.reason, "sync stream")
  return ownSyncStream(DB.useDatabase(dbName).model(model), model, route.pipeline, onEvent)
}

/**
 * A sync stream on a change stream of its own, kept open: when it ends on its own (a
 * non-resumable error, an invalidate) it is reopened after 1 s, doubling to 30 s, and the
 * client is told to pull once it is back. Left dead, the client heard of nobody's writes until
 * it reconnected.
 */
export async function ownSyncStream(
  collection: { watch(pipeline: Document[], options: any): any },
  model: string,
  pipeline: Document[],
  onEvent: () => void
) {
  let closed = false
  let current: OpenWatch | undefined
  let failures = 0
  let openedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // Whether the stream started: one that died while starting (a pipeline the server rejects)
  // already set the next retry through died(). It used to be kept as `current` and the client
  // told to pull anyway — a pull at every backoff that read nothing new.
  const open = async (): Promise<boolean> => {
    openedAt = 0 // starting: a death now is not one after a long healthy run
    let dead = false
    const w = await openChangeStreamWatch({
      collection,
      model,
      pipeline,
      options: { fullDocument: "updateLookup" },
      onEvent: () => {
        failures = 0
        onEvent()
      },
      onDead: () => {
        dead = true
        died()
      },
      label: "sync",
    })
    if (closed || dead) {
      await w.close().catch(() => {})
      return false
    }
    current = w
    openedAt = Date.now()
    return true
  }
  function died() {
    // The watch that died is closed before another replaces it: the driver closes a stream that
    // reached 'error', but one that failed while starting may keep its cursor and listeners, and
    // the final unsubscribe closes only the newest. (onDead fires once per watch; current is
    // cleared here, so a later death — a reopen dying while starting — closes nothing twice.)
    const gone = current
    current = undefined
    gone?.close().catch(() => {})
    if (closed || timer) return
    // A stream that ran a while had recovered, even on a collection too quiet to deliver an
    // event: its earlier deaths stop counting, or one death a day grew the wait to 30 s.
    if (openedAt && Date.now() - openedAt > STABLE_LIFE_MS) failures = 0
    failures++
    timer = setTimeout(async () => {
      timer = undefined
      if (closed) return
      try {
        // Writes made while it was down were seen by nothing.
        if ((await open()) && !closed) onEvent()
      } catch (err) {
        console.warn(`[mogobase/sync] could not reopen the sync stream on ${model}:`, err)
        died()
      }
    }, backoffDelay(failures))
    timer.unref?.()
  }
  await open()
  return async () => {
    closed = true
    if (timer) clearTimeout(timer)
    await current?.close()
  }
}

function parseCheckpoint(checkpoint: number | null): number {
  if (checkpoint == null) return EPOCH
  if (typeof checkpoint === "number" && !isNaN(checkpoint)) return checkpoint
  return EPOCH
}

// A number, or a BSON number an import left (Decimal128, Long — a numeric read returns them, and
// MongoDB orders them by value), as a JS number.
function numberOf(value: any): number | undefined {
  if (typeof value === "number") return value
  if (value && typeof value === "object" && ["Decimal128", "Long", "Int32", "Double"].includes(value._bsontype)) {
    const n = Number(String(value))
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function pickEffectiveTimestamp(doc: any): number {
  // Retrofit: pre-existing docs without updatedAt fall back to createdAt, then epoch.
  const updated = numberOf(doc?.updatedAt)
  if (updated !== undefined) return updated
  if (doc?.updatedAt instanceof Date) return doc.updatedAt.getTime()
  if (doc?.updatedAt) {
    const d = new Date(doc.updatedAt)
    if (!isNaN(d.getTime())) return d.getTime()
  }
  const created = numberOf(doc?.createdAt)
  if (created !== undefined) return created
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

/** A model sync refuses for good — not declared `sync: true`, or a time-series one. Never retried. */
export class SyncRefusedError extends Error {}

export function requireSyncEnabled(model: string): void {
  if (isTimeseries(model)) {
    throw new SyncRefusedError(
      `Model "${model}" is a time-series collection. Sync is not supported on time-series models — they have restricted update semantics and cannot carry soft-delete tombstones.`
    )
  }
  if (!isSyncEnabled(model)) {
    throw new SyncRefusedError(
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
  // From the client (a sync-pull frame, an HTTP body): a whole number from 1 to 1000. "all" was NaN
  // — slice(0, NaN) answered nothing, for ever — and 50.5 never equalled a batch's length, so a
  // group was never completed.
  const asked = Math.floor(Number(args.batchSize ?? 200))
  const batchSize = Number.isFinite(asked) ? Math.max(1, Math.min(asked, 1000)) : 200

  await DB.connect()
  const collection = DB.model(model)
  const since = parseCheckpoint(checkpoint)

  // Pull anything modified after `since`. We DO NOT filter on deletedAt:null —
  // tombstones must propagate. updatedAt is auto-stamped on every write
  // including soft-deletes (see autoStamp.ts).
  //
  // Index-range reads — find(), never an aggregation: an aggregation's $match refuses a policy
  // filter's $where or $near (round F19's broke every pull of such a policy), and reading rows by
  // a timestamp computed at pull time scanned the collection on every pull — each sorted on its
  // one field (a two-field sort was done in memory), at most a batch, merged by page key (pageKey):
  //  - updatedAt a number, after the checkpoint: every row mogobase stamps;
  //  - updatedAt a Date after it: an import's, or a caller's new Date() (engineTimestamp accepts
  //    one) — a numeric $gt never matches a Date, so such a row was never pulled after the first;
  //  - no updatedAt, by a numeric createdAt after it: a row written before sync. In one read sorted
  //    by { updatedAt, createdAt } such rows came first, and a batch ending on one skipped every
  //    row with an older updatedAt for good;
  //  - on a pull from the start, rows with a string updatedAt too (page key 0), which main's first
  //    pull returned.
  // Rows with page key 0 come only on a pull from the start (before the rest); a probe
  // (probeUnpageable) finds them and warns once, with the one-off updateMany that stamps them.
  probeUnpageable(collection, model)
  const projection = buildProjection(model)
  const find = (part: Record<string, any>, sort?: Record<string, 1>, limit = !!sort) => {
    const cursor = collection.find(combineFilter(part, extraFilter))
    if (projection) cursor.project(projection)
    if (sort) cursor.sort(sort)
    if (limit) cursor.limit(batchSize)
    return cursor.toArray()
  }
  const sinceDate = dateOf(since)
  const none = Promise.resolve([] as Document[])
  const reads = await Promise.all([
    find(since === 0 ? { updatedAt: { $type: "number" } } : { updatedAt: { $gt: since } }, { updatedAt: 1 }),
    since === 0 || (since < 0 && !sinceDate)
      ? find({ updatedAt: { $type: "date" } }, { updatedAt: 1 })
      : sinceDate
        ? find({ updatedAt: { $gt: sinceDate } }, { updatedAt: 1 })
        : none,
    find(since === 0 ? { updatedAt: null } : { updatedAt: null, createdAt: { $gt: since } }, { createdAt: 1 }),
    since === 0 ? find({ updatedAt: { $type: "string" } }, undefined, true) : none,
  ])
  const docs = reads
    .flat()
    .sort((a, b) => pageKey(a) - pageKey(b))
    .slice(0, batchSize)

  // A batch never ends inside a group of rows sharing one page key: the checkpoint is that key
  // and the next pull asks for rows after it, so the rest of the group was skipped for good. A soft
  // deleteMany stamps every row with one Date.now(): deleting more rows than the batch size left
  // the rest live on every client. A full batch takes the rest of its last group, past batchSize
  // (a client keeps pulling while a batch is full) — appended one by one: spread into push, a
  // group past ~100 000 rows overflowed the call stack and every pull of the model threw — but not
  // a group at 0: there is no paging those rows (warned), and taken whole a pre-sync collection
  // with no stamps came in one answer.
  const last = docs.length ? pageKey(docs[docs.length - 1]) : 0
  if (docs.length === batchSize && last > 0) {
    const lastDate = dateOf(last)
    const atLast = { $or: [{ updatedAt: last }, ...(lastDate ? [{ updatedAt: lastDate }] : []), { updatedAt: null, createdAt: last }] }
    for (const row of await find({ $and: [atLast, { _id: { $nin: docs.map((d) => d._id) } }] })) docs.push(row)
  }

  const documents = docs.map(toSyncDoc)
  // The last row's page key — what the reads select by — never 0 once a row is answered: 0 reads
  // as "from the start", and a batch of rows with no timestamp at all answered 0 — the next pull
  // read the same rows again, for ever.
  const lastTs = documents.length ? Math.max(last, 1) : checkpoint

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

// A find-style filter as a change-stream $match pipeline: `{ userId: "bob" }` becomes
// `[{ $match: { "fullDocument.userId": "bob" } }]`.
/**
 * @deprecated Neither transport uses it: sync streams narrow by `syncChangeMatch`. Kept for
 * callers that import it, prefixing as syncChangeMatch does (its own prefixing left the fields
 * inside $or/$and/$nor unprefixed, naming nothing on a change event) — but failing closed: a
 * filter a change stream cannot run ($where, $text, $near) stays, so the caller's stream fails to
 * open rather than widening. syncChangeMatch's unnarrowed fallback is safe only for mogobase's own
 * sync-stream frames, which name the model alone; a caller of this may stream whole documents.
 */
export function filterToWatchPipeline(filter: Record<string, any>): Document[] {
  if (!filter || Object.keys(filter).length === 0) return []
  return [{ $match: prefixFilterWithFullDocument(filter, true) }]
}

/**
 * Open one model's sync subscription and keep trying until it opens: a failure (MongoDB
 * unreachable as it subscribed, a policy that threw) is tried again on backoffDelay — 1 s doubling
 * to 30 s — while a SyncRefusedError is not, nor `open` answering undefined (a policy's refusal).
 * Once open after a failure, `reopened()`: writes made meanwhile were seen by nothing. An open
 * landing after `ended()` is unsubscribed. Shared by syncSubscribe and streamChanges, which gave
 * up on the first failure: a model that could not open as it started never streamed.
 */
export function openSyncStreamRetrying(args: {
  model: string
  /** Log prefix and what is opening: `[mogobase/<label>] <what> failed, retrying, for <model>`. */
  label: string
  what: string
  open: () => Promise<(() => Promise<void>) | undefined>
  ended: () => boolean
  opened: (unsubscribe: () => Promise<void>) => void
  reopened: () => void
  timers: Set<ReturnType<typeof setTimeout>>
}): Promise<void> {
  const attempt = async (n: number): Promise<void> => {
    if (args.ended()) return
    try {
      const unsubscribe = await args.open()
      if (!unsubscribe) return
      if (args.ended()) return void unsubscribe().catch(() => {})
      args.opened(unsubscribe)
      if (n > 0) args.reopened()
    } catch (err) {
      if (err instanceof SyncRefusedError) return logRefusal(args.label, args.what, args.model, err)
      console.warn(`[mogobase/${args.label}] ${args.what} failed, retrying, for ${args.model}:`, err)
      if (args.ended()) return
      const timer = setTimeout(() => {
        args.timers.delete(timer)
        void attempt(n + 1)
      }, backoffDelay(n + 1))
      timer.unref?.()
      args.timers.add(timer)
    }
  }
  return attempt(0)
}

// A refusal is logged as one line, not with its stack: the model list of a sync-subscribe comes
// from the client, and every refusal logged in full let a client looping over made-up names flood
// the server's log. A registered model (declared without sync: true, or time-series — the app's
// own misconfiguration) is logged once per (what, model): the app's models bound the set. A name
// no defineModel registered is client input: at most one line a minute, counting the rest — a
// fixed cap on logged names was used up by such names, and a real misconfiguration shipped later
// was refused with no log line at all.
const refusalsLogged = new Set<string>()
const UNKNOWN_REFUSAL_GAP_MS = 60_000
let unknownRefusalLoggedAt = -Infinity
let unknownRefusalsSince = 0

function logRefusal(label: string, what: string, model: string, err: Error): void {
  if (latestModelDef(model)) {
    const key = `${what}\u0000${model}`
    if (refusalsLogged.has(key)) return
    refusalsLogged.add(key)
    console.warn(`[mogobase/${label}] ${what} refused for ${model}: ${err.message} (logged once per model)`)
    return
  }
  const now = Date.now()
  if (now - unknownRefusalLoggedAt < UNKNOWN_REFUSAL_GAP_MS) {
    unknownRefusalsSince++
    return
  }
  const more = unknownRefusalsSince ? `; ${unknownRefusalsSince} more such refusals since the last line` : ""
  unknownRefusalLoggedAt = now
  unknownRefusalsSince = 0
  console.warn(`[mogobase/${label}] ${what} refused for ${model}: no model of that name is registered (at most one such line a minute${more})`)
}

export function streamChanges(
  specs: SyncStreamSpec[],
  onEvent: (model: string) => void
): () => void {
  let cancelled = false
  const unsubs: (() => Promise<void>)[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  // Every model at once, each connecting lazily (callers don't await) and retrying on its own.
  for (const spec of specs) {
    const model = typeof spec === "string" ? spec : spec.model
    // Narrowed as the spec says. A spec's pipeline was ignored here (every change of the model
    // streamed), so a policy's tenant filter never reached the legacy transport's sync-stream
    // frames: every client heard of every other tenant's writes.
    const narrow = typeof spec === "string" ? {} : { match: syncChangeMatch(spec.filter), pipeline: spec.pipeline }
    void openSyncStreamRetrying({
      model,
      label: "sync",
      what: "streamChanges",
      open: async () => {
        requireSyncEnabled(model) // refused before connecting
        await DB.connect()
        // The DEFAULT database, explicitly: sync is documented as bound to MONGO_DB
        // (multi-tenant sync is not supported), and this legacy path has no request to resolve
        // one from. Naming it beats inheriting whatever the hub keyed first.
        return subscribeSyncStream(syncHub(), DB.db.databaseName, model, () => onEvent(model), narrow)
      },
      ended: () => cancelled,
      opened: (unsubscribe) => unsubs.push(unsubscribe),
      reopened: () => onEvent(model),
      timers,
    })
  }

  return () => {
    cancelled = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const u of unsubs.splice(0)) u().catch(() => {})
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
