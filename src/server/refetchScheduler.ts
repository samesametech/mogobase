// Trailing-edge debounced scheduler (with an optional max wait) and at-most-one-in-flight-
// plus-one-queued backpressure. The live-query engine (liveQuery.ts) keys it per SUBSCRIPTION
// (socket id + slot key): change events of every watch of one subscription fold into one re-run
// of it, a change reaching several subscriptions on a socket re-runs each once, and a write
// storm cannot stack unbounded refetches.

export type ScheduledRun = () => Promise<void>

export type RefetchScheduler = {
  schedule(key: string, run: ScheduledRun): void
  cancel(key: string): void
  cancelAll(): void
}

type Slot = {
  timer: NodeJS.Timeout | null
  /** When the current burst's first schedule came: a burst emits by maxWaitMs after it. */
  burstStart: number
  inFlight: boolean
  queued: boolean
  lastRun: ScheduledRun | null
}

/**
 * `maxWaitMs`: the longest a burst may hold a run back. A trailing debounce alone waits for a
 * quiet gap, so writes arriving faster than `debounceMs` apart (a webhook burst, an import)
 * froze every subscriber's updates for the whole burst. With it, a long burst still emits
 * every `maxWaitMs`. Unset: no limit (the debounce alone).
 */
export function createRefetchScheduler(opts: { debounceMs: number; maxWaitMs?: number }): RefetchScheduler {
  const { debounceMs, maxWaitMs } = opts
  const slots = new Map<string, Slot>()

  function getSlot(key: string): Slot {
    let s = slots.get(key)
    if (!s) {
      s = { timer: null, burstStart: 0, inFlight: false, queued: false, lastRun: null }
      slots.set(key, s)
    }
    return s
  }

  function isIdle(slot: Slot): boolean {
    return !slot.timer && !slot.inFlight && !slot.queued
  }

  function pruneIfIdle(key: string): void {
    const slot = slots.get(key)
    if (slot && isIdle(slot)) slots.delete(key)
  }

  async function fire(key: string, run: ScheduledRun): Promise<void> {
    const slot = getSlot(key)
    if (slot.inFlight) {
      slot.queued = true
      slot.lastRun = run
      return
    }
    slot.inFlight = true
    slot.queued = false
    try {
      await run()
    } catch (err) {
      console.warn("[mogobase/refetchScheduler] run failed:", err)
    } finally {
      slot.inFlight = false
      // Cancelled while it ran: its entry is gone (or a new one stands for the key) — nothing of
      // it is re-fired or pruned.
      if (slots.get(key) !== slot) return
      if (slot.queued && slot.lastRun) {
        const next = slot.lastRun
        slot.lastRun = null
        slot.queued = false
        fire(key, next).catch(() => {})
      } else {
        pruneIfIdle(key)
      }
    }
  }

  return {
    schedule(key, run) {
      const slot = getSlot(key)
      slot.lastRun = run
      const now = Date.now()
      if (slot.timer) clearTimeout(slot.timer)
      else slot.burstStart = now
      const wait = maxWaitMs === undefined ? debounceMs : Math.max(0, Math.min(debounceMs, slot.burstStart + maxWaitMs - now))
      slot.timer = setTimeout(() => {
        slot.timer = null
        const r = slot.lastRun
        if (r) {
          slot.lastRun = null
          fire(key, r).catch(() => {})
        } else {
          pruneIfIdle(key)
        }
      }, wait)
    },
    // Removes the entry even while a run of it is in flight. Kept, a run that never settled (a
    // hung handler) left the key in flight for good: every later schedule of it — a replacement
    // subscription's re-runs — was queued behind it and never fired, and the entry, with the
    // socket in its closures, was never removed. The run in flight finishes on its own.
    cancel(key) {
      const slot = slots.get(key)
      if (!slot) return
      if (slot.timer) {
        clearTimeout(slot.timer)
        slot.timer = null
      }
      slot.queued = false
      slot.lastRun = null
      slots.delete(key)
    },
    cancelAll() {
      for (const [key, slot] of slots) {
        if (slot.timer) {
          clearTimeout(slot.timer)
          slot.timer = null
        }
        slot.queued = false
        slot.lastRun = null
        if (isIdle(slot)) slots.delete(key)
      }
    },
  }
}
