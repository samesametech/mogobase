// A sync stream of its own reopens itself when it ends, on the shared backoff — and forgets
// old failures once it has run a while (review round 8).
import { EventEmitter } from "events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ownSyncStream } from "@/server/sync"
import { backoffDelay } from "@/server/backoff"

class Stream extends EventEmitter {
  async close() {}
}

function collection() {
  const opened: Stream[] = []
  return {
    opened,
    watch: () => {
      const s = new Stream()
      opened.push(s)
      setTimeout(() => s.emit("resumeTokenChanged", {}), 0) // started on the server
      return s
    },
  }
}

afterEach(() => vi.useRealTimers())

describe("backoffDelay", () => {
  it("1 s, doubling, capped at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    expect(backoffDelay(3, 5)).toBe(20)
  })
})

describe("ownSyncStream (review round 8)", () => {
  it("a stream that ran a while before dying is reopened after 1 s, not after the backoff old deaths earned", async () => {
    vi.useFakeTimers()
    const c = collection()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const startP = ownSyncStream(c, "m", [{ $match: {} }], () => {})
    await vi.advanceTimersByTimeAsync(1)
    const close = await startP
    // Three quick deaths: 1 s, 2 s, 4 s.
    for (const wait of [1000, 2000, 4000]) {
      c.opened.at(-1)!.emit("close")
      await vi.advanceTimersByTimeAsync(wait + 1)
    }
    expect(c.opened).toHaveLength(4)
    // Then a day of quiet health, and one death: reopened after 1 s again, not 8 s.
    await vi.advanceTimersByTimeAsync(24 * 3600_000)
    c.opened.at(-1)!.emit("close")
    await vi.advanceTimersByTimeAsync(1001)
    expect(c.opened).toHaveLength(5)
    await close()
    warn.mockRestore()
  })
})

describe("ownSyncStream (review round 9)", () => {
  it("a reopen that dies while starting, after a long healthy run, backs off to 2 s — the old run does not reset it again", async () => {
    vi.useFakeTimers()
    const opened: Stream[] = []
    const c = {
      watch: () => {
        const s = new Stream()
        const n = opened.push(s)
        // The second stream (the first reopen) is refused as it starts.
        setTimeout(() => (n === 2 ? s.emit("error", new Error("refused")) : s.emit("resumeTokenChanged", {})), 0)
        return s
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const startP = ownSyncStream(c, "m", [{ $match: {} }], () => {})
    await vi.advanceTimersByTimeAsync(1)
    const close = await startP
    await vi.advanceTimersByTimeAsync(120_000) // healthy for two minutes
    opened[0].emit("close") // dies: old failures forgotten, reopened after 1 s…
    await vi.advanceTimersByTimeAsync(1001)
    expect(opened).toHaveLength(2) // …which dies while starting: the next wait is 2 s
    await vi.advanceTimersByTimeAsync(1500)
    expect(opened).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(600)
    expect(opened).toHaveLength(3)
    await close()
    warn.mockRestore()
  })
})

describe("ownSyncStream (review round 13)", () => {
  it("a reopen that dies while starting tells the client nothing, and is not kept as the live stream", async () => {
    vi.useFakeTimers()
    const opened: Stream[] = []
    const c = {
      watch: () => {
        const s = new Stream()
        const n = opened.push(s)
        // Every reopen is refused as it starts (a pipeline the server now rejects).
        setTimeout(() => (n > 1 ? s.emit("error", new Error("refused")) : s.emit("resumeTokenChanged", {})), 0)
        return s
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    let pulls = 0
    const startP = ownSyncStream(c, "m", [{ $match: {} }], () => pulls++)
    await vi.advanceTimersByTimeAsync(1)
    const close = await startP
    opened[0].emit("close")
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 10)
    expect(opened).toHaveLength(4) // reopened on the backoff…
    expect(pulls).toBe(0) // …but none of them started: a pull would read nothing new, every time
    await close()
    warn.mockRestore()
  })

  it("a reopen that starts tells the client to pull once", async () => {
    vi.useFakeTimers()
    const c = collection()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    let pulls = 0
    const startP = ownSyncStream(c, "m", [{ $match: {} }], () => pulls++)
    await vi.advanceTimersByTimeAsync(1)
    const close = await startP
    c.opened[0].emit("close")
    await vi.advanceTimersByTimeAsync(1001)
    expect(c.opened).toHaveLength(2)
    expect(pulls).toBe(1)
    await close()
    warn.mockRestore()
  })
})

describe("ownSyncStream (review round F14)", () => {
  // A reopen overwrote the dead watch and never closed it, trusting the driver to have closed
  // the stream after 'error' — one that failed while starting could keep its cursor and
  // listeners, and the final unsubscribe closed only the newest watch.
  it("closes a watch that died before replacing it", async () => {
    vi.useFakeTimers()
    const c = collection()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const startP = ownSyncStream(c, "m", [{ $match: {} }], () => {})
    await vi.advanceTimersByTimeAsync(1)
    const close = await startP
    const first = c.opened[0]
    const closed = vi.spyOn(first, "close")
    first.emit("error", new Error("cursor killed"))
    await vi.advanceTimersByTimeAsync(1001)
    expect(c.opened).toHaveLength(2)
    expect(closed).toHaveBeenCalled()
    await close()
    warn.mockRestore()
  })
})
