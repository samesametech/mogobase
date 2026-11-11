import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRefetchScheduler } from "@/server/refetchScheduler"

describe("refetchScheduler — debounce", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("coalesces a burst of events into a single run", async () => {
    const run = vi.fn(async () => {})
    const sched = createRefetchScheduler({ debounceMs: 100 })
    for (let i = 0; i < 50; i++) sched.schedule("k1", run)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("each event resets the timer (trailing edge)", async () => {
    const run = vi.fn(async () => {})
    const sched = createRefetchScheduler({ debounceMs: 100 })
    sched.schedule("k1", run)
    await vi.advanceTimersByTimeAsync(80)
    sched.schedule("k1", run)
    await vi.advanceTimersByTimeAsync(80)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("different keys are independent", async () => {
    const a = vi.fn(async () => {})
    const b = vi.fn(async () => {})
    const sched = createRefetchScheduler({ debounceMs: 100 })
    sched.schedule("a", a)
    sched.schedule("b", b)
    await vi.advanceTimersByTimeAsync(100)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("cancel(key) clears a pending timer", async () => {
    const run = vi.fn(async () => {})
    const sched = createRefetchScheduler({ debounceMs: 100 })
    sched.schedule("k1", run)
    sched.cancel("k1")
    await vi.advanceTimersByTimeAsync(200)
    expect(run).not.toHaveBeenCalled()
  })

  it("cancelAll clears all pending timers", async () => {
    const run = vi.fn(async () => {})
    const sched = createRefetchScheduler({ debounceMs: 100 })
    sched.schedule("a", run)
    sched.schedule("b", run)
    sched.cancelAll()
    await vi.advanceTimersByTimeAsync(200)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("refetchScheduler — backpressure", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("at-most-one-inflight: events during run are coalesced into one queued run", async () => {
    let resolveFirst!: () => void
    const firstPromise = new Promise<void>((res) => { resolveFirst = res })
    let runCount = 0
    const run = vi.fn(async () => {
      runCount++
      if (runCount === 1) await firstPromise
    })

    const sched = createRefetchScheduler({ debounceMs: 100 })
    sched.schedule("k1", run)
    await vi.advanceTimersByTimeAsync(100)
    expect(runCount).toBe(1)

    for (let i = 0; i < 10; i++) {
      sched.schedule("k1", run)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(runCount).toBe(1)

    resolveFirst()
    await vi.runAllTimersAsync()
    expect(runCount).toBe(2)
  })

  it("a failing run does not block subsequent runs", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined)
    const sched = createRefetchScheduler({ debounceMs: 100 })
    sched.schedule("k1", run)
    await vi.advanceTimersByTimeAsync(100)
    await vi.runAllTimersAsync()
    sched.schedule("k1", run)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe("refetchScheduler — maxWait (scalability review)", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("a burst with events closer than the debounce still runs every maxWaitMs", async () => {
    const run = vi.fn(async () => {})
    const sched = createRefetchScheduler({ debounceMs: 100, maxWaitMs: 1000 })
    for (let t = 0; t < 2000; t += 50) {
      sched.schedule("k", run)
      await vi.advanceTimersByTimeAsync(50)
    }
    // A webhook burst of 2 s: without maxWait, nothing ran until it ended.
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(run.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it("without maxWaitMs, a burst runs once, after it ends", async () => {
    const run = vi.fn(async () => {})
    const sched = createRefetchScheduler({ debounceMs: 100 })
    for (let t = 0; t < 2000; t += 50) {
      sched.schedule("k", run)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe("refetchScheduler: review round F9", () => {
  // cancel() left an in-flight entry in the map: a replaced subscription's hung re-run kept its
  // key in flight, so its replacement's every later run was queued behind it — and never fired —
  // and the entry (with the socket in its closures) was never removed.
  it("cancel removes an entry even while its run is in flight; the next schedule starts afresh", async () => {
    const { createRefetchScheduler } = await import("@/server/refetchScheduler")
    const scheduler = createRefetchScheduler({ debounceMs: 0 })
    let started = 0
    scheduler.schedule("k", () => {
      started++
      return new Promise<void>(() => {}) // hangs
    })
    await vi.waitFor(() => expect(started).toBe(1))
    scheduler.cancel("k")
    let ran = false
    scheduler.schedule("k", async () => void (ran = true))
    await vi.waitFor(() => expect(ran).toBe(true))
  })
})
