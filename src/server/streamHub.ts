// Process-level shared change streams. Replaces the per-(socket, watch-call)
// change stream model in attachWs.ts, reducing MongoDB stream count from
// O(connections × watches) to O(active models).
//
// Each model gets ONE unfiltered MongoDB change stream when the first
// subscriber joins; subscribers register a filter and a callback. When events
// arrive, each subscriber's filter is evaluated in JS via filterMatcher; only
// matching subscribers see the event. The stream is closed (and the slot
// cleared) when the last subscriber leaves.
//
// Filter limitation: unsupported operators ($expr, $where, $elemMatch, $text)
// throw at subscribe time. Callers needing those should fall back to the
// legacy per-socket model.watch(pipeline) path in attachWs.ts.

import { matches, isSupportedFilter } from "@/runtime/filterMatcher"
import type { MongoFilter } from "@/runtime/filterMatcher"

export type StreamHubChangeType = "insert" | "update" | "replace" | "delete"

export type SubscriberCallback = (doc: any | null, type: StreamHubChangeType | "error") => void

export type StreamHubOptions = {
  openStream: (model: string) => Promise<{
    on(event: "change", listener: (change: any) => void): unknown
    on(event: "error", listener: (err: Error) => void): unknown
    on(event: "close", listener: () => void): unknown
    close(): Promise<void>
  }>
  reconnectDelayMs?: number
}

export type StreamHub = {
  subscribe(
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

export function createStreamHub(opts: StreamHubOptions): StreamHub {
  const { openStream, reconnectDelayMs = 1000 } = opts
  const slots = new Map<string, Slot>()

  async function ensureStream(model: string, slot: Slot): Promise<void> {
    if (slot.stream) return
    const stream = await openStream(model)
    slot.stream = stream
    stream.on("change", (change: any) => {
      const type = (change.operationType || "update") as StreamHubChangeType
      const doc = change.fullDocument ?? null
      const passesFilter = (sub: Subscriber): boolean => {
        if (type === "delete" || !doc) return true
        if (!sub.filter) return true
        return matches(doc, sub.filter)
      }
      for (const sub of slot.subs) {
        if (passesFilter(sub)) {
          try {
            sub.cb(doc, type)
          } catch (err) {
            console.warn("[mogobase/streamHub] subscriber threw:", err)
          }
        }
      }
    })
    stream.on("error", (err: Error) => {
      console.warn(`[mogobase/streamHub] stream error for ${model}:`, err)
      reconnect(model, slot).catch((e) => {
        console.warn(`[mogobase/streamHub] reconnect failed for ${model}:`, e)
        for (const sub of slot.subs) {
          try { sub.cb(null, "error") } catch {}
        }
      })
    })
  }

  async function reconnect(model: string, slot: Slot): Promise<void> {
    if (slot.reconnecting) return
    slot.reconnecting = true
    try {
      try { await slot.stream?.close() } catch {}
      slot.stream = null
      await new Promise((r) => setTimeout(r, reconnectDelayMs))
      if (slot.subs.size === 0) return
      await ensureStream(model, slot)
    } finally {
      slot.reconnecting = false
    }
  }

  return {
    async subscribe(model, filter, cb) {
      if (!isSupportedFilter(filter)) {
        throw new Error(`unsupported filter operator in ${JSON.stringify(filter)}`)
      }
      let slot = slots.get(model)
      if (!slot) {
        slot = { stream: null, subs: new Set(), reconnecting: false }
        slots.set(model, slot)
      }
      const sub: Subscriber = { id: nextSubId++, filter, cb }
      slot.subs.add(sub)
      try {
        await ensureStream(model, slot)
      } catch (err) {
        slot.subs.delete(sub)
        if (slot.subs.size === 0) slots.delete(model)
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
          // the same model would attach to this dying slot, then be orphaned
          // when slots.delete() runs after the await — symptom: subscriber
          // never receives events.
          if (slots.get(model) === slot) slots.delete(model)
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
