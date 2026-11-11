// Process-level shared change streams. Replaces the per-(socket, watch-call)
// change stream model in attachWs.ts, reducing MongoDB stream count from
// O(connections × watches) to O(active databases × models).
//
// Each (database, model) gets ONE MongoDB change stream when the first subscriber joins —
// unfiltered by default, or (server-filter mode) with a $match OR-ing its subscribers'
// filters. The DATABASE is part of the key because a per-request resolver
// (DB.setRequestResolver) can bind two sockets to different databases: keyed by model alone,
// the second socket would silently attach to the first one's stream and be told about another
// database's writes — or, far more likely, about nothing at all while its own changed.
//
// Subscribers register a filter and a callback. When events arrive, each subscriber's filter
// is evaluated in JS via filterMatcher against the FULL change event (not just fullDocument),
// so filters use the native MongoDB shape — `"fullDocument.userId"`, `"operationType"`,
// `"documentKey._id"`, etc. — exactly like a `$match` stage you would write in
// `collection.watch([{ $match: ... }])`. The stream is closed (and the slot cleared) when the
// last subscriber leaves.
//
// What the JS matcher cannot run ($expr, $where, $elemMatch, $text, …, or a pipeline stage
// other than $match) never reaches the hub: routeWatchInput (watchInput.ts) sends it to a
// change stream of its own, and subscribe() rejects it as a last guard.

import type { Document } from "mongodb"
import { matches, isSupportedFilter } from "@/runtime/filterMatcher"
import type { MongoFilter } from "@/runtime/filterMatcher"
import { changedPaths, onlyIgnoredPaths, toServerMatch } from "./watchInput"
import { filterKey, stableStringify } from "./stableStringify"
import { backoffDelay, STABLE_LIFE_MS } from "./backoff"

export type StreamHubChangeType = "insert" | "update" | "replace" | "delete"

/**
 * `doc` is the change's full document when the event carries one — null for a delete, and for
 * an update on a server-filtered stream none of whose subscribers filters on the document.
 * `"error"`: informational — the slot's stream has failed three times in a row; the hub keeps
 * reconnecting on its backoff, and every subscriber gets a `"resync"` once it is back. Nothing
 * needs undoing: surface it (a log, a metric, a "live updates delayed" hint) or ignore it.
 * Live queries and sync streams ignore it. `"resync"`: the stream was reopened without a resume
 * point, so a change may have been missed — re-read.
 */
export type SubscriberCallback = (doc: any | null, type: StreamHubChangeType | "error" | "resync") => void

/**
 * A subscriber that acts on every change and on "resync", and lets "error" pass (the hub is
 * still reconnecting; see above). What live queries and sync streams both want.
 */
export function onChangeOrResync(onEvent: () => void): SubscriberCallback {
  return (_doc, type) => {
    if (type !== "error") onEvent()
  }
}

export type HubStream = {
  on(event: "change", listener: (change: any) => void): unknown
  on(event: "error", listener: (err: Error) => void): unknown
  on(event: "close", listener: () => void): unknown
  close(): Promise<void>
  /** The driver's latest resume token (ChangeStream#resumeToken); absent on a stream with no batch yet. */
  readonly resumeToken?: unknown
}

/** How a slot's stream is opened in server-filter mode. */
export type HubStreamSpec = {
  /** `[]`, or one `$match` that is the OR of the slot's subscriber filters. */
  pipeline: Document[]
  /** Look the full document up for updates (`fullDocument: "updateLookup"`). */
  fullDocument: boolean
  /** Start after this resume token, so no change between the old stream and this one is lost. */
  startAfter?: unknown
}

export type StreamHubOptions = {
  /**
   * Open a slot's stream. Called without `spec` in the default mode (one unfiltered stream
   * with `fullDocument: "updateLookup"`, matched in JS), with one in server-filter mode.
   */
  openStream: (dbName: string, model: string, spec?: HubStreamSpec) => Promise<HubStream>
  reconnectDelayMs?: number
  /**
   * Resolves once a stream just opened runs on the server (see `streamStarted`). A subscribe,
   * and a resync after a reconnect, wait for it: a read made before the stream started can miss
   * a write the stream then never reports. Without it a stream counts as started when opened.
   */
  whenReady?: (stream: HubStream) => Promise<void>
  /**
   * Push the subscribers' filters into the stream's `$match`, so a change no subscriber of
   * this process matches is never sent to it, and look the full document up only when a
   * subscriber filters on it. Default false: an unfiltered stream, every change sent, JS
   * matching only. See the README for the trade-off.
   */
  serverSideFilters?: boolean
  /** Server-filter mode: how long subscriber changes coalesce before the stream reopens. */
  reopenDelayMs?: number
}

export type StreamHubSubscribeOptions = {
  /** Skip update events that changed only these fields (see `touchesOnlyIgnored`). */
  ignoreFields?: readonly string[]
}

export type StreamHub = {
  subscribe(
    dbName: string,
    model: string,
    filter: MongoFilter | undefined,
    onChange: SubscriberCallback,
    options?: StreamHubSubscribeOptions
  ): Promise<() => Promise<void>>
  size(): number
  shutdown(): Promise<void>
}

type Subscriber = {
  id: number
  filter: MongoFilter | undefined
  ignoreFields?: readonly string[]
  cb: SubscriberCallback
  // Server-filter mode only.
  /** The filter's key in the slot's `$match`, or null when the stream must carry every change for it. */
  filterKey: string | null
  readsDocument: boolean
}

/** What a server-filtered stream was opened with: its filter keys (null: every change), and the lookup. */
type OpenedSpec = { keys: Set<string> | null; fullDocument: boolean }

type Slot = {
  key: string
  dbName: string
  model: string
  stream: HubStream | null
  opening?: Promise<void>
  subs: Set<Subscriber>
  reconnecting: boolean
  /** Consecutive stream failures with no change delivered in between: drives the reconnect backoff. */
  failures: number
  /** Consecutive failed reopens (server-filter mode): the same backoff and "error" as a reconnect. */
  reopenFailures: number
  // Server-filter mode only — kept as counts, so a subscribe or unsubscribe costs O(1) however
  // many subscribers a slot has, and the $match is rebuilt only when a reopen actually runs.
  filters: Map<string, { filter: MongoFilter; n: number }>
  /** Subscribers that need every change: unfiltered, or a filter MongoDB cannot run. */
  everything: number
  /** Subscribers whose filter reads the full document, which then has to be looked up. */
  docReaders: number
  opened?: OpenedSpec
  /**
   * Subscribers the current stream does not cover yet, in join order, each with the stream's
   * resume token when it joined (undefined when there was no stream, or no token yet). A
   * covered subscriber is never listed, so a token here is never older than a reopen delay.
   */
  pending: Map<Subscriber, unknown>
  reopenTimer?: ReturnType<typeof setTimeout>
  /** After a failed reopen: no reopen before this time, whoever asks for one. */
  reopenNotBefore?: number
  reopening?: Promise<void>
  /** Resolves when the slot's current stream runs on the server (whenReady), or at once. */
  ready?: Promise<void>
}

let nextSubId = 1

// One stream per (database, model). The database has to be in the key: with a
// per-request resolver two sockets can be bound to different databases, and a
// model-only key would hand the second one the first one's stream.
const slotKey = (dbName: string, model: string) => `${dbName}::${model}`

const LOGICAL = new Set(["$and", "$or", "$nor"])

/** How many failures in a row before subscribers hear "error". Backoff: see ./backoff. */
const FAILURES_BEFORE_ERROR = 3

/** Whether a change-event filter reads the full document — and so needs it looked up for updates. */
export function referencesFullDocument(filter: any): boolean {
  if (!filter || typeof filter !== "object") return false
  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL.has(key)) {
      if (Array.isArray(value) && value.some(referencesFullDocument)) return true
    } else if (key === "$not") {
      if (referencesFullDocument(value)) return true
    } else if (key === "fullDocument" || key.startsWith("fullDocument.")) {
      return true
    }
  }
  return false
}

/** A filter's key in a server-filtered stream's `$match`; null when it needs every change. */
function filterKeyOf(filter: MongoFilter | undefined): string | null {
  if (!filter || !Object.keys(filter).length) return null
  return filterKey(filter) // embedded-document equality keeps its key order; the rest is sorted
}

// `filters` are the slot's distinct filters, keyed by their filterKeyOf string, so a reopen
// does not serialize each of them again.
function buildSpec(
  filters: Map<string, { filter: MongoFilter }>,
  everything: boolean,
  fullDocument: boolean
): { pipeline: Document[]; opened: OpenedSpec } {
  if (everything || !filters.size) return { pipeline: [], opened: { keys: null, fullDocument } }
  // As MongoDB can run them: a logical `$not` (JS-matcher-only) becomes `$nor` (toServerMatch).
  // Such a filter used to drop the whole slot's $match, so one subscriber with a `$not` sent the
  // process every change on that collection, and looked up every update's document.
  const matches = [...filters.values()].map((e) => toServerMatch(e.filter))
  return {
    pipeline: [{ $match: matches.length === 1 ? matches[0] : { $or: matches } }],
    opened: { keys: new Set(filters.keys()), fullDocument },
  }
}

export function createStreamHub(opts: StreamHubOptions): StreamHub {
  const { openStream, reconnectDelayMs = 1000, serverSideFilters = false, reopenDelayMs = 50, whenReady } = opts
  const slots = new Map<string, Slot>()

  // ——— server-filter bookkeeping: O(1) per subscriber; true when the stream's spec may change.
  const addSub = (slot: Slot, sub: Subscriber): boolean => {
    slot.subs.add(sub)
    if (!serverSideFilters) return false
    let changed = false
    if (sub.filterKey === null) changed = slot.everything++ === 0
    else {
      const entry = slot.filters.get(sub.filterKey)
      if (entry) entry.n++
      else {
        slot.filters.set(sub.filterKey, { filter: sub.filter!, n: 1 })
        changed = true
      }
    }
    if (sub.readsDocument && slot.docReaders++ === 0) changed = true
    return changed
  }

  const removeSub = (slot: Slot, sub: Subscriber): boolean => {
    if (!slot.subs.delete(sub)) return false
    slot.pending.delete(sub)
    if (!serverSideFilters) return false
    let changed = false
    if (sub.filterKey === null) changed = --slot.everything === 0
    else {
      const entry = slot.filters.get(sub.filterKey)
      if (entry && --entry.n === 0) {
        slot.filters.delete(sub.filterKey)
        changed = true
      }
    }
    if (sub.readsDocument && --slot.docReaders === 0) changed = true
    return changed
  }

  const currentSpec = (slot: Slot) => buildSpec(slot.filters, slot.everything > 0, slot.docReaders > 0)

  const covers = (opened: OpenedSpec | undefined, sub: Subscriber) =>
    !!opened &&
    (!sub.readsDocument || opened.fullDocument) &&
    (opened.keys === null || (sub.filterKey !== null && opened.keys.has(sub.filterKey)))

  // Whether the subscribers now want a different stream than the one open. O(distinct filters);
  // called only when a reopen is about to run, never per subscribe.
  const stale = (slot: Slot) => {
    const o = slot.opened
    if (!o) return false
    if (o.fullDocument !== slot.docReaders > 0) return true
    const all = slot.everything > 0 || slot.filters.size === 0
    if (all !== (o.keys === null)) return true
    if (all) return false
    if (o.keys!.size !== slot.filters.size) return true
    for (const key of slot.filters.keys()) if (!o.keys!.has(key)) return true
    return false
  }

  // Open the slot's stream: unfiltered by default; to the current subscribers' spec in
  // server-filter mode, resuming after `startAfter` when given.
  async function open(slot: Slot, startAfter?: unknown): Promise<{ stream: HubStream; opened?: OpenedSpec }> {
    if (!serverSideFilters) return { stream: await openStream(slot.dbName, slot.model) }
    const spec = currentSpec(slot)
    const stream = await openStream(slot.dbName, slot.model, {
      pipeline: spec.pipeline,
      fullDocument: spec.opened.fullDocument,
      ...(startAfter !== undefined ? { startAfter } : {}),
    })
    return { stream, opened: spec.opened }
  }

  function ensureStream(slot: Slot): Promise<void> {
    if (slot.stream) return slot.ready ?? Promise.resolve()
    // Concurrent callers share ONE open. Without it each opened its own stream, the last
    // assignment won, and the rest leaked forever with their listeners still attached.
    slot.opening ??= open(slot)
      .then(({ stream, opened }) => {
        attach(slot, stream, opened)
        return slot.stream === stream ? slot.ready : undefined
      })
      .finally(() => {
        slot.opening = undefined
      })
    return slot.opening
  }

  function notify(subs: Iterable<Subscriber>, type: "error" | "resync") {
    for (const sub of [...subs]) {
      try {
        sub.cb(null, type)
      } catch (err) {
        console.warn("[mogobase/streamHub] subscriber threw:", err)
      }
    }
  }

  // Make `stream` the slot's stream. Returns the pending subscribers it covers (with the token
  // each joined at), now no longer pending.
  // `joinToken`: where a reopen's stream starts. A subscriber that joined while it opened was
  // checked against the OLD stream, which covered it; if the new one does not, it is pending
  // from there — or writes to its filter between this attach and the next reopen reached no
  // stream, and it was never told to re-read.
  function attach(slot: Slot, stream: HubStream, opened?: OpenedSpec, joinToken?: unknown): [Subscriber, unknown][] {
    // Every subscriber left while it was opening: the slot is gone, so nobody else would close it.
    if (slot.subs.size === 0 || slots.get(slot.key) !== slot) {
      stream.close().catch(() => {})
      return []
    }
    slot.stream = stream
    slot.opened = opened
    const attachedAt = Date.now()
    const covered: [Subscriber, unknown][] = []
    for (const [sub, token] of slot.pending) {
      if (!covers(opened, sub)) continue
      covered.push([sub, token])
      slot.pending.delete(sub)
    }
    if (serverSideFilters) {
      for (const sub of slot.subs) if (!covers(opened, sub) && !slot.pending.has(sub)) slot.pending.set(sub, joinToken)
    }
    // A stream replaced by a reopen stops dispatching the moment its successor is attached.
    stream.on("change", (change: any) => {
      if (slot.stream !== stream) return
      slot.failures = 0
      const type = (change.operationType || "update") as StreamHubChangeType
      const doc = change.fullDocument ?? null
      let paths: string[] | null | undefined // the update's changed paths, once per change
      for (const sub of slot.subs) {
        // One subscriber's filter that throws (a malformed one given to subscribe directly)
        // skips that subscriber: it ran outside the try, so it skipped every later subscriber
        // and threw back into the driver's emit, ending the stream for the whole collection.
        try {
          if (sub.filter && !matches(change, sub.filter)) continue
          if (sub.ignoreFields && onlyIgnoredPaths((paths ??= changedPaths(change)), sub.ignoreFields)) continue
          sub.cb(doc, type)
        } catch (err) {
          console.warn("[mogobase/streamHub] subscriber threw:", err)
        }
      }
    })
    // An error, or a close nobody here asked for — an invalidate after the collection was
    // dropped or renamed — ends the stream: reconnect. Without the close, a slot whose stream
    // ended cleanly kept it as "open", and every subscriber, present and future, heard nothing.
    const ended = (reason: unknown) => {
      if (slot.stream !== stream || slots.get(slot.key) !== slot || slot.subs.size === 0) return
      // A stream that ran a while was healthy, even on a collection too quiet to deliver a change.
      if (Date.now() - attachedAt > STABLE_LIFE_MS) slot.failures = 0
      console.warn(`[mogobase/streamHub] stream ended for ${slot.key}:`, reason)
      // Detached at once. A reconnect already running — this call then returns at once — must
      // see the stream is gone, not take it for the healthy one it was waiting for: a stream that
      // died while a reconnect slept (a subscribe had opened it) or while it started stayed the
      // slot's stream for good, and every subscriber heard nothing more, with no "error" either.
      slot.stream = null
      slot.ready = undefined
      stream.close().catch(() => {})
      void reconnect(slot)
    }
    stream.on("error", (err: Error) => ended(err))
    stream.on("close", () => ended("closed"))
    // Listeners are on, so the stream is starting: whoever reads after it waits for this.
    slot.ready = whenReady ? whenReady(stream).catch(() => {}) : undefined
    // Subscribers that changed while it opened: open again to their spec.
    if (serverSideFilters && (slot.pending.size > 0 || stale(slot))) scheduleReopen(slot)
    return covered
  }

  // Reconnect with backoff (reconnectDelayMs, doubling to 30 s) for as long as the slot has
  // subscribers. A failure that recurs — a permission error, a namespace that cannot be
  // watched — used to reconnect every second forever with nobody told; after three in a row
  // the subscribers now hear "error" (and may re-subscribe), while the slot keeps trying.
  async function reconnect(slot: Slot): Promise<void> {
    if (slot.reconnecting) return
    slot.reconnecting = true
    try {
      const failed = slot.stream
      slot.stream = null
      try {
        await failed?.close()
      } catch {}
      for (;;) {
        slot.failures++
        if (slot.failures === FAILURES_BEFORE_ERROR) notify(slot.subs, "error")
        await new Promise((r) => setTimeout(r, backoffDelay(slot.failures, reconnectDelayMs)).unref?.())
        if (slot.subs.size === 0 || slots.get(slot.key) !== slot) return
        try {
          await ensureStream(slot)
          // Only a stream still attached counts: one that died while it started was detached.
          if (slot.stream) break
        } catch (err) {
          console.warn(`[mogobase/streamHub] reconnect failed for ${slot.key}:`, err)
        }
      }
      // The failed stream's position cannot be trusted (an error that reaches us is one the
      // driver could not resume from), so the new stream starts fresh — after whatever was
      // written during the backoff — and every subscriber re-reads, in both modes. Without it a
      // live query showed the rows it had before the failure until some unrelated write re-ran it.
      if (slot.stream) {
        // Subscribers the new stream does not cover yet (they joined while it opened) stay
        // pending for the reopen attach() scheduled — with no join point, since the failed
        // stream's cannot be trusted, so that reopen tells them to re-read once it covers them.
        // Cleared instead, they re-read now, the reopen resumed from the new stream's position
        // without them, and a write to their filter in between went unseen.
        for (const sub of slot.pending.keys()) slot.pending.set(sub, undefined)
        notify(slot.subs, "resync")
      }
    } finally {
      slot.reconnecting = false
      // A reopen that ran while this did returned early (reopen leaves a reconnecting slot
      // alone): ask again, or a subscriber left pending would wait for a membership change.
      if (serverSideFilters && slot.stream && slots.get(slot.key) === slot && (slot.pending.size > 0 || stale(slot))) {
        scheduleReopen(slot)
      }
    }
  }

  // A slot its last subscriber left: out of the map, its reopen timer cancelled — on every path
  // (a failed subscribe used to leave the timer to fire on the orphaned slot).
  function forget(slot: Slot) {
    if (slots.get(slot.key) === slot) slots.delete(slot.key)
    if (slot.reopenTimer) clearTimeout(slot.reopenTimer)
    slot.reopenTimer = undefined
  }

  // One reopen at a time per slot, coalesced: a request while one is scheduled joins it (the
  // reopen reads the subscribers when it runs). After a failed reopen the next waits out the
  // backoff — a subscribe or unsubscribe in the meantime used to schedule one at the short
  // reopenDelayMs, so a busy slot hammered a failing server with no backoff at all. The timer
  // is the slot's own, so the last unsubscribe and shutdown cancel it.
  function scheduleReopen(slot: Slot) {
    if (slot.reopenTimer) return
    const wait = Math.max(reopenDelayMs, (slot.reopenNotBefore ?? 0) - Date.now())
    slot.reopenTimer = setTimeout(() => {
      slot.reopenTimer = undefined
      slot.reopening = (slot.reopening ?? Promise.resolve()).then(() =>
        reopen(slot).catch((err) => {
          console.warn(`[mogobase/streamHub] reopen failed for ${slot.key}:`, err)
          // Their join points age while this retries: have them re-read instead of resuming far back.
          for (const sub of slot.pending.keys()) slot.pending.set(sub, undefined)
          // Back off like a reconnect, and tell the subscribers on the third failure in a row.
          slot.reopenFailures++
          if (slot.reopenFailures === FAILURES_BEFORE_ERROR) notify(slot.subs, "error")
          slot.reopenNotBefore = Date.now() + backoffDelay(slot.reopenFailures, reconnectDelayMs)
          if (slots.get(slot.key) === slot && slot.subs.size > 0) scheduleReopen(slot)
        })
      )
    }, wait)
    slot.reopenTimer.unref?.()
  }

  // Server-filter mode: the subscribers want a different $match than the open stream's. The
  // new stream resumes from the earliest join point among the subscribers the old one does not
  // cover — or, if none is waiting, from where the old stream is — so neither the subscribers
  // it keeps nor the ones it gains miss a change in between. A subscriber with no join point to
  // resume from (it joined while no stream was open) is told to re-read instead.
  async function reopen(slot: Slot): Promise<void> {
    if (slots.get(slot.key) !== slot || slot.subs.size === 0 || slot.reconnecting) return
    if (slot.opening) await slot.opening.catch(() => {})
    const old = slot.stream
    if (!old || slots.get(slot.key) !== slot || slot.subs.size === 0) return
    if (!slot.pending.size && !stale(slot)) return
    let startAfter: unknown = undefined
    for (const token of slot.pending.values()) {
      if (token !== undefined) {
        startAfter = token
        break
      }
    }
    if (startAfter === undefined) startAfter = old.resumeToken
    const { stream, opened } = await open(slot, startAfter)
    if (slot.stream !== old) {
      // Reconnected, closed or reopened meanwhile; that path already owns the slot.
      stream.close().catch(() => {})
      return
    }
    const covered = attach(slot, stream, opened, startAfter)
    old.close().catch(() => {})
    if (slot.stream !== stream) return
    await slot.ready
    // Died while it started — a $match MongoDB rejects, say: ended() handed the slot to
    // reconnect(), which backs off and tells the subscribers on the third failure in a row. Not a
    // success, so it does not reset the reopen backoff. (open() itself rarely rejects: watch()
    // returns at once and a start failure arrives later, as an 'error'.)
    if (slot.stream !== stream) return
    slot.reopenFailures = 0
    slot.reopenNotBefore = undefined
    const resync =
      startAfter === undefined
        ? [...slot.subs]
        : covered.filter(([sub, token]) => token === undefined && slot.subs.has(sub)).map(([sub]) => sub)
    notify(resync, "resync")
  }

  return {
    async subscribe(dbName, model, filter, cb, options) {
      if (!isSupportedFilter(filter)) {
        throw new Error(`unsupported filter operator in ${stableStringify(filter)}`) // JSON.stringify threw on a BigInt
      }
      const key = slotKey(dbName, model)
      let slot = slots.get(key)
      if (!slot) {
        slot = {
          key,
          dbName,
          model,
          stream: null,
          subs: new Set(),
          reconnecting: false,
          failures: 0,
          reopenFailures: 0,
          filters: new Map(),
          everything: 0,
          docReaders: 0,
          pending: new Map(),
        }
        slots.set(key, slot)
      }
      const sub: Subscriber = {
        id: nextSubId++,
        filter,
        cb,
        ignoreFields: options?.ignoreFields,
        filterKey: serverSideFilters ? filterKeyOf(filter) : null,
        readsDocument: serverSideFilters && referencesFullDocument(filter),
      }
      const changed = addSub(slot, sub)
      // A subscriber the open stream does not cover: remember where the stream was, so the
      // reopen that covers it resumes from here.
      if (serverSideFilters && !covers(slot.opened, sub)) {
        slot.pending.set(sub, slot.stream?.resumeToken)
        if (slot.stream && changed) scheduleReopen(slot)
      }
      // A slot sleeping out its reconnect backoff is not opened here: the reconnect opens it and
      // tells every subscriber to re-read. Opening at once let each new socket (and each retry of
      // a watch that failed to open) try the stream again during an outage, past the backoff.
      if (!slot.reconnecting) {
        try {
          await ensureStream(slot)
        } catch (err) {
          removeSub(slot, sub)
          if (slot.subs.size === 0) forget(slot)
          throw err
        }
      }
      let unsubscribed = false
      return async () => {
        if (unsubscribed) return
        unsubscribed = true
        const changedOnLeave = removeSub(slot!, sub)
        if (slot!.subs.size === 0) {
          // Remove the slot from the map *before* awaiting stream.close().
          // Otherwise, during the close await, a concurrent subscribe() for
          // the same (database, model) would attach to this dying slot, then be orphaned
          // when slots.delete() runs after the await — symptom: subscriber
          // never receives events.
          forget(slot!)
          try {
            await slot!.stream?.close()
          } catch {}
        } else if (serverSideFilters && changedOnLeave && slot!.stream) {
          scheduleReopen(slot!)
        }
      }
    },
    size() {
      return slots.size
    },
    async shutdown() {
      for (const [, slot] of slots) {
        slot.subs.clear() // an open still in flight closes itself on landing
        if (slot.reopenTimer) clearTimeout(slot.reopenTimer)
        try {
          await slot.stream?.close()
        } catch {}
      }
      slots.clear()
    },
  }
}
