// Trailing-edge debounced scheduler with at-most-one-inflight-plus-one-queued
// backpressure. Used by attachWs to coalesce change-stream events into a
// single refetch per (socket, query, args) tuple, and to ensure a write storm
// cannot self-DoS the server by stacking unbounded refetches.

export type ScheduledRun = () => Promise<void>

export type RefetchScheduler = {
  schedule(key: string, run: ScheduledRun): void
  cancel(key: string): void
  cancelAll(): void
}

type Slot = {
  timer: NodeJS.Timeout | null
  inFlight: boolean
  queued: boolean
  lastRun: ScheduledRun | null
}

export function createRefetchScheduler(opts: { debounceMs: number }): RefetchScheduler {
  const { debounceMs } = opts
  const slots = new Map<string, Slot>()

  function getSlot(key: string): Slot {
    let s = slots.get(key)
    if (!s) {
      s = { timer: null, inFlight: false, queued: false, lastRun: null }
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
      if (slot.timer) clearTimeout(slot.timer)
      slot.timer = setTimeout(() => {
        slot.timer = null
        const r = slot.lastRun
        if (r) {
          slot.lastRun = null
          fire(key, r).catch(() => {})
        } else {
          pruneIfIdle(key)
        }
      }, debounceMs)
    },
    cancel(key) {
      const slot = slots.get(key)
      if (!slot) return
      if (slot.timer) {
        clearTimeout(slot.timer)
        slot.timer = null
      }
      slot.queued = false
      slot.lastRun = null
      pruneIfIdle(key)
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
