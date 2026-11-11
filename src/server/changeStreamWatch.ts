// A live-query watch on a change stream of its own: a pipeline the shared hub cannot
// evaluate (attachWs), or any watch on the legacy ws.ts transport. Both transports open it
// here, so the two cannot drift: the same option split, the same `ignoreFields` handling,
// the same error log.

import type { ChangeStreamOptions, Document } from "mongodb"
import { normalizeIgnoreFields, touchesOnlyIgnored } from "./watchInput"
import { filterKey, stableStringify } from "./stableStringify"
import type { OpenWatch } from "./liveQuery"
import type { HubStream, HubStreamSpec } from "./streamHub"
import DB from "@/db"

const warnedOwnStreams = new Set<string>()

/**
 * Logged once per (kind of watch, collection, operator) — the kind too, or a live query's warning
 * silenced the sync stream's: a watch using an operator no change stream runs ($where, $text,
 * $near) watches the whole collection instead (routeWatchInput).
 */
export function warnUnnarrowed(dbName: string, model: string, operator: string, what: "live-query watch" | "sync stream"): void {
  // Per kind of watch too: keyed without it, a live query's warning silenced the sync stream's.
  const key = `unnarrowed\u0000${what}\u0000${model}\u0000${operator}`
  if (warnedOwnStreams.has(key)) return
  warnedOwnStreams.add(key)
  const cost = what === "sync stream" ? "makes subscribed clients pull" : "re-runs it"
  console.warn(
    `[mogobase] a ${what} on ${dbName}.${model} uses ${operator}, which a change stream cannot run: it watches the ` +
      `whole collection instead, so every write to ${model} ${cost}. Express the filter without ${operator} to ` +
      `narrow it. (Logged once per kind of watch, collection and operator.)`
  )
}

/**
 * Logged once per (kind of watch, collection, reason) — the kind too, or a live query's warning
 * silenced the sync stream's: a watch the shared hub cannot evaluate
 * ($elemMatch, $expr, a $project stage, …) gets a change stream of its own for EVERY subscriber
 * — one pooled connection each, O(sockets) rather than one per collection — which is easy to
 * ship without noticing until the pool runs dry.
 */
export function warnOwnStream(dbName: string, model: string, reason: string | undefined, what: string): void {
  // Keyed without the database: per-tenant databases would grow the set (and repeat the
  // warning) once per tenant. The first database it was seen in is named.
  // Per kind of watch too: keyed without it, a live query's warning silenced the sync stream's.
  const key = `${what}\u0000${model}\u0000${reason}`
  if (warnedOwnStreams.has(key)) return
  warnedOwnStreams.add(key)
  console.warn(
    `[mogobase] a ${what} on ${dbName}.${model} uses ${reason ?? "a pipeline"}, which the shared change stream ` +
      `cannot evaluate: each subscriber gets a change stream of its own, holding a pooled connection ` +
      `(one per subscriber, not one per collection). On a collection many clients watch, use $match with ` +
      `operators the shared stream supports. (Logged once per kind of watch, collection and reason.)`
  )
}

/**
 * How a stream hub opens its (database, model) stream: unfiltered with the full document looked
 * up (the default), or to a server-filter spec. One function for attachWs's hub and the sync
 * hub, which had each grown a copy.
 */
export async function openHubStream(dbName: string, model: string, spec?: HubStreamSpec): Promise<HubStream> {
  await DB.connect()
  const collection = DB.useDatabase(dbName).model(model)
  if (!spec) return collection.watch([], { fullDocument: "updateLookup" }) as any
  return collection.watch(spec.pipeline, {
    ...(spec.fullDocument ? { fullDocument: "updateLookup" } : {}),
    ...(spec.startAfter !== undefined ? { startAfter: spec.startAfter as any } : {}),
  }) as any
}

/**
 * Split a ctx.watch() options bag into mogobase's own `ignoreFields` and the
 * ChangeStreamOptions the driver takes. mogobase's own keys — `ignoreFields`, and the
 * pagination keys WatchOptions still accepts (`paginatedField`, `sortAscending`) — must never
 * reach the driver: it forwards unknown keys to the server, which rejects the `$changeStream`,
 * and the watch dies.
 *
 * `fullDocument` and `fullDocumentBeforeChange` are dropped too. The transports set
 * `fullDocument` themselves, and an event only triggers a re-run, so a pre-image is never
 * read — while asking for one kills the watch: `"required"` on a collection without
 * pre-images enabled, and any value on MongoDB before 6.0.
 */
export function splitWatchOptions(options: unknown): {
  driverOptions: Record<string, unknown>
  ignoreFields?: string[]
  /** `dbName`: where the caller says to watch (see WatchOptions.dbName). */
  dbName?: string
} {
  if (!options || typeof options !== "object") return { driverOptions: {} }
  const {
    ignoreFields,
    dbName,
    paginatedField: _paginatedField,
    sortAscending: _sortAscending,
    fullDocument: _fullDocument,
    fullDocumentBeforeChange: _fullDocumentBeforeChange,
    ...driverOptions
  } = options as Record<string, unknown>
  return {
    driverOptions,
    ignoreFields: normalizeIgnoreFields(ignoreFields),
    ...(typeof dbName === "string" && dbName ? { dbName } : {}),
  }
}

type StartingStream = {
  once(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}

/** How long an open waits for its change stream to start on the server before going on anyway. */
export const STREAM_START_TIMEOUT_MS = 10_000

/**
 * Resolves once `stream` runs on the server: its first resume token (a fresh stream gets one
 * with the empty first batch that answers its `$changeStream` aggregate; any change sets one
 * too) — or its end, or `timeoutMs`. `collection.watch()` returns before that: the aggregate is
 * sent when a 'change' listener is attached and answered later, and the server starts the
 * stream when it runs. A read made in between saw the database as it was before a write the
 * stream then never reported — the gap a catch-up run or a resync exists to close, reopened
 * because the watch only looked open. Call it after the 'change' and 'error' listeners are on.
 */
export function streamStarted(stream: StartingStream, timeoutMs = STREAM_START_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const events = ["resumeTokenChanged", "error", "close", "end"]
    const done = () => {
      clearTimeout(timer)
      for (const event of events) stream.removeListener(event, done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()
    for (const event of events) stream.once(event, done)
  })
}

export async function openChangeStreamWatch(args: {
  collection: { watch(pipeline: Document[], options: ChangeStreamOptions): any }
  model: string
  pipeline: Document[]
  options: ChangeStreamOptions
  ignoreFields?: readonly string[]
  onEvent: () => void
  /** The stream ended without us closing it — a non-resumable error, an invalidate. */
  onDead?: () => void
  label: string
}): Promise<OpenWatch> {
  const { collection, model, pipeline, options, ignoreFields, onEvent, onDead, label } = args
  const changeStream = collection.watch(pipeline, options)
  let closing = false
  let dead = false
  const died = () => {
    if (closing || dead) return
    dead = true
    onDead?.()
  }
  changeStream.on("change", (change: any) => {
    if (ignoreFields && touchesOnlyIgnored(change, ignoreFields)) return
    onEvent()
  })
  // The driver resumes a resumable error by itself; one that reaches 'error' ends the stream.
  changeStream.on("error", (err: unknown) => {
    console.warn(`[mogobase/${label}] change stream error on ${model}:`, err)
    died()
  })
  changeStream.on("close", died)
  await streamStarted(changeStream)
  return {
    close: () => {
      closing = true
      return changeStream.close().catch(() => {})
    },
  }
}

/**
 * The key a watch is compared by across runs — equal watches are the one already open, kept.
 * One format for both transports: the kind of watch, where it watches, what it filters on,
 * the driver options of its own stream, and its ignoreFields.
 */
export function watchKey(parts: {
  kind: "hub" | "stream"
  dbName: string
  model: string
  filter: unknown
  driverOptions?: Record<string, unknown>
  ignoreFields?: readonly string[]
}): string {
  return [
    parts.kind,
    parts.dbName,
    parts.model,
    filterKey(parts.filter ?? null), // conditions sorted, embedded documents in their own order
    stableStringify(parts.driverOptions ?? {}),
    stableStringify(parts.ignoreFields ?? null),
  ].join("|")
}

/**
 * A live query's watch on a change stream of its own, opened from its spec the same way on both
 * transports (attachWs's own-stream watches, every watch on ws.ts): the watch's pipeline and
 * driver options, the full document looked up on updates — and no fullDocumentBeforeChange: an
 * event only triggers a re-run, so the pre-image is never read, and MongoDB before 6.0 rejects the
 * option, killing the watch.
 */
export function openSpecWatch(
  spec: { model: string; [field: string]: any },
  onEvent: () => void,
  onDead: () => void,
  label: string
) {
  // A live-query WatchSpec carries these as untyped fields (its index signature): a transport whose
  // watchSpec stopped setting them failed deep in the open, as a retried-watch warning only.
  if (typeof spec.db?.model !== "function" || !Array.isArray(spec.pipeline)) {
    throw new Error(`[mogobase] a watch on ${spec.model} has no db or pipeline to open a change stream with`)
  }
  return openChangeStreamWatch({
    collection: spec.db.model(spec.model),
    model: spec.model,
    pipeline: spec.pipeline,
    options: { ...spec.options, fullDocument: "updateLookup" },
    ignoreFields: spec.ignoreFields,
    onEvent,
    onDead,
    label,
  })
}
