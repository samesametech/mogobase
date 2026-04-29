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
