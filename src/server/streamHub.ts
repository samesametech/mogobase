// Process-level shared change streams. Replaces the per-(socket, watch-call)
// change stream model in attachWs.ts, reducing MongoDB stream count from
// O(connections × watches) to O(active databases × models).
//
// Each (database, model) gets ONE unfiltered MongoDB change stream when the
// first subscriber joins. The DATABASE is part of the key because a per-request
// resolver (DB.setRequestResolver) can bind two sockets to different databases:
// keyed by model alone, the second socket would silently attach to the first
// one's stream and be told about another database's writes — or, far more
// likely, be told about nothing at all while its own database changed.
//
// Subscribers register a filter and a callback. When events
// arrive, each subscriber's filter is evaluated in JS via filterMatcher
// against the FULL change event (not just fullDocument), so filters use the
// native MongoDB shape — `"fullDocument.userId"`, `"operationType"`,
// `"documentKey._id"`, etc. — exactly like a `$match` stage you would write
// in `collection.watch([{ $match: ... }])`. The stream is closed (and the
// slot cleared) when the last subscriber leaves.
//
// Filter limitation: unsupported operators ($expr, $where, $elemMatch, $text)
// throw at subscribe time. Pipelines containing stages other than $match
// (e.g. $project, $addFields) can't be evaluated in JS; callers should route
// those to a per-socket `model.watch(pipeline)` instead.

import { matches, isSupportedFilter } from "@/runtime/filterMatcher"
import type { MongoFilter } from "@/runtime/filterMatcher"

export type StreamHubChangeType = "insert" | "update" | "replace" | "delete"

export type SubscriberCallback = (doc: any | null, type: StreamHubChangeType | "error") => void

export type StreamHubOptions = {
  openStream: (dbName: string, model: string) => Promise<{
    on(event: "change", listener: (change: any) => void): unknown
    on(event: "error", listener: (err: Error) => void): unknown
    on(event: "close", listener: () => void): unknown
    close(): Promise<void>
  }>
  reconnectDelayMs?: number
}

export type StreamHub = {
  subscribe(
    dbName: string,
    model: string,
    filter: MongoFilter | undefined,
    onChange: SubscriberCallback
  ): Promise<() => Promise<void>>
  size(): number
  shutdown(): Promise<void>
}

type Subscriber = {
  id: number
  filter: MongoFilter | undefined
  cb: SubscriberCallback
}

type Slot = {
  stream: Awaited<ReturnType<StreamHubOptions["openStream"]>> | null
  subs: Set<Subscriber>
  reconnecting: boolean
}

let nextSubId = 1

// One stream per (database, model). The database has to be in the key: with a
// per-request resolver two sockets can be bound to different databases, and a
// model-only key would hand the second one the first one's stream.
const slotKey = (dbName: string, model: string) => `${dbName}::${model}`

export function createStreamHub(opts: StreamHubOptions): StreamHub {
  const { openStream, reconnectDelayMs = 1000 } = opts
  const slots = new Map<string, Slot>()

  async function ensureStream(dbName: string, model: string, slot: Slot): Promise<void> {
    if (slot.stream) return
    const stream = await openStream(dbName, model)
    slot.stream = stream
    stream.on("change", (change: any) => {
      const type = (change.operationType || "update") as StreamHubChangeType
      const doc = change.fullDocument ?? null
      for (const sub of slot.subs) {
        if (sub.filter && !matches(change, sub.filter)) continue
        try {
          sub.cb(doc, type)
        } catch (err) {
          console.warn("[mogobase/streamHub] subscriber threw:", err)
        }
      }
    })
    stream.on("error", (err: Error) => {
      console.warn(`[mogobase/streamHub] stream error for ${slotKey(dbName, model)}:`, err)
      reconnect(dbName, model, slot).catch((e) => {
        console.warn(`[mogobase/streamHub] reconnect failed for ${slotKey(dbName, model)}:`, e)
        for (const sub of slot.subs) {
          try { sub.cb(null, "error") } catch {}
        }
      })
    })
  }

  async function reconnect(dbName: string, model: string, slot: Slot): Promise<void> {
    if (slot.reconnecting) return
    slot.reconnecting = true
    try {
      try { await slot.stream?.close() } catch {}
      slot.stream = null
      await new Promise((r) => setTimeout(r, reconnectDelayMs))
      if (slot.subs.size === 0) return
      await ensureStream(dbName, model, slot)
    } finally {
      slot.reconnecting = false
    }
  }

  return {
    async subscribe(dbName, model, filter, cb) {
      if (!isSupportedFilter(filter)) {
        throw new Error(`unsupported filter operator in ${JSON.stringify(filter)}`)
      }
      const key = slotKey(dbName, model)
      let slot = slots.get(key)
      if (!slot) {
        slot = { stream: null, subs: new Set(), reconnecting: false }
        slots.set(key, slot)
      }
      const sub: Subscriber = { id: nextSubId++, filter, cb }
      slot.subs.add(sub)
      try {
        await ensureStream(dbName, model, slot)
      } catch (err) {
        slot.subs.delete(sub)
        if (slot.subs.size === 0) slots.delete(key)
        throw err
      }
      let unsubscribed = false
      return async () => {
        if (unsubscribed) return
        unsubscribed = true
        slot!.subs.delete(sub)
        if (slot!.subs.size === 0) {
          // Remove the slot from the map *before* awaiting stream.close().
          // Otherwise, during the close await, a concurrent subscribe() for
          // the same (database, model) would attach to this dying slot, then be orphaned
          // when slots.delete() runs after the await — symptom: subscriber
          // never receives events.
          if (slots.get(key) === slot) slots.delete(key)
          try { await slot!.stream?.close() } catch {}
        }
      }
    },
    size() {
      return slots.size
    },
    async shutdown() {
      for (const [, slot] of slots) {
        try { await slot.stream?.close() } catch {}
      }
      slots.clear()
    },
  }
}
