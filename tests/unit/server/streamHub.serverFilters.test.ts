// The hub's server-filter mode (attachWs `serverSideWatchFilters`), with fake streams: what
// each stream is opened with, when it reopens, from where, and who is told to re-read.
import { EventEmitter } from "events"
import { describe, expect, it, vi } from "vitest"
import { createStreamHub, type HubStreamSpec } from "@/server/streamHub"
import type { MongoFilter } from "@/runtime/filterMatcher"

class Stream extends EventEmitter {
  closed = false
  resumeToken: unknown = undefined
  constructor(public spec?: HubStreamSpec) {
    super()
  }
  async close() {
    this.closed = true
  }
  change(event: any) {
    this.emit("change", event)
  }
}

function setup(serverSideFilters = true) {
  const opened: Stream[] = []
  const hub = createStreamHub({
    serverSideFilters,
    reopenDelayMs: 0,
    reconnectDelayMs: 0,
    openStream: async (_db, _model, spec) => {
      const s = new Stream(spec)
      opened.push(s)
      return s
    },
  })
  const settle = () => new Promise((r) => setTimeout(r, 10))
  return { hub, opened, settle }
}

const orgA = { "fullDocument.org": "a" }
const orgB = { "fullDocument.org": "b" }
const update = (org: string) => ({ operationType: "update", fullDocument: { org }, documentKey: { _id: org } })

describe("the stream a slot opens", () => {
  // Read off the stream the hub actually opened for these subscribers, not a helper beside it.
  async function specFor(filters: (MongoFilter | undefined)[]) {
    const { hub, opened, settle } = setup()
    for (const filter of filters) await hub.subscribe("db", "m", filter, vi.fn())
    await settle()
    const spec = opened.at(-1)!.spec!
    await hub.shutdown()
    return spec
  }

  it("ORs distinct filters, and looks the document up only when a filter reads it", async () => {
    expect(await specFor([orgA, orgA])).toMatchObject({ pipeline: [{ $match: orgA }], fullDocument: true })
    expect((await specFor([orgA, orgB])).pipeline).toEqual([{ $match: { $or: [orgA, orgB] } }])
    expect(await specFor([{ operationType: "delete" }])).toMatchObject({ fullDocument: false })
  })

  it("no server $match when a subscriber is unfiltered", async () => {
    expect((await specFor([orgA, undefined])).pipeline).toEqual([])
    expect((await specFor([{ $or: [orgA, { "fullDocument.n": { $gt: 1 } }] }])).pipeline).toHaveLength(1)
  })

  it("a logical $not (JS-matcher-only) reaches MongoDB as $nor, not as an unfiltered stream (review round 9)", async () => {
    expect((await specFor([orgA, { $not: orgB } as any])).pipeline).toEqual([{ $match: { $or: [orgA, { $nor: [orgB] }] } }])
    expect((await specFor([{ $or: [orgA, { $not: orgB }] } as any])).pipeline).toEqual([{ $match: { $or: [orgA, { $nor: [orgB] }] } }])
  })
})

describe("streamHub: default mode is unchanged", () => {
  it("opens one stream with no spec — the unfiltered, looked-up stream it always opened", async () => {
    const { hub, opened, settle } = setup(false)
    await hub.subscribe("db", "m", orgA, vi.fn())
    await hub.subscribe("db", "m", orgB, vi.fn())
    await settle()
    expect(opened).toHaveLength(1)
    expect(opened[0].spec).toBeUndefined()
  })
})

describe("streamHub: server-filter mode", () => {
  it("opens to its subscriber's filter, and widens from where the next subscriber joined", async () => {
    const { hub, opened, settle } = setup()
    const a = vi.fn()
    const b = vi.fn()
    await hub.subscribe("db", "m", orgA, a)
    expect(opened[0].spec).toEqual({ pipeline: [{ $match: orgA }], fullDocument: true })

    opened[0].resumeToken = { _data: "T1" }
    await hub.subscribe("db", "m", orgB, b)
    opened[0].resumeToken = { _data: "T2" } // the old stream moves on before the reopen
    await settle()

    expect(opened).toHaveLength(2)
    expect(opened[1].spec).toEqual({ pipeline: [{ $match: { $or: [orgA, orgB] } }], fullDocument: true, startAfter: { _data: "T1" } })
    expect(opened[0].closed).toBe(true)

    opened[0].change(update("a")) // the retired stream no longer dispatches
    expect(a).not.toHaveBeenCalled()
    opened[1].change(update("b"))
    expect(b).toHaveBeenCalledWith({ org: "b" }, "update")
    expect(a).not.toHaveBeenCalled()
  })

  it("narrows when a subscriber leaves, resuming where the old stream was, without a resync", async () => {
    const { hub, opened, settle } = setup()
    const a = vi.fn()
    await hub.subscribe("db", "m", orgA, a)
    opened[0].resumeToken = { _data: "T1" }
    const offB = await hub.subscribe("db", "m", orgB, vi.fn())
    await settle()
    opened[1].resumeToken = { _data: "T3" }
    await offB()
    await settle()
    expect(opened).toHaveLength(3)
    expect(opened[2].spec).toEqual({ pipeline: [{ $match: orgA }], fullDocument: true, startAfter: { _data: "T3" } })
    expect(a).not.toHaveBeenCalled()
  })

  it("a joiner with no resume point to start from is told to re-read; the others are not", async () => {
    const { hub, opened, settle } = setup()
    const a = vi.fn()
    const b = vi.fn()
    await hub.subscribe("db", "m", orgA, a)
    await hub.subscribe("db", "m", orgB, b) // the stream has no token yet
    opened[0].resumeToken = { _data: "T1" }
    await settle()
    expect(opened[1].spec?.startAfter).toEqual({ _data: "T1" })
    expect(b).toHaveBeenCalledWith(null, "resync")
    expect(a).not.toHaveBeenCalled()
  })

  it("with no resume point at all, every subscriber is told to re-read", async () => {
    const { hub, opened, settle } = setup()
    const a = vi.fn()
    await hub.subscribe("db", "m", orgA, a)
    await hub.subscribe("db", "m", orgB, vi.fn())
    await settle()
    expect(opened[1].spec?.startAfter).toBeUndefined()
    expect(a).toHaveBeenCalledWith(null, "resync")
  })

  it("an unchanged filter set does not reopen; an unfiltered subscriber drops the server $match", async () => {
    const { hub, opened, settle } = setup()
    await hub.subscribe("db", "m", orgA, vi.fn())
    await hub.subscribe("db", "m", orgA, vi.fn())
    await settle()
    expect(opened).toHaveLength(1)
    await hub.subscribe("db", "m", undefined, vi.fn())
    await settle()
    expect(opened[1].spec?.pipeline).toEqual([])
  })

  it("after a stream error it reopens fresh and every subscriber re-reads", async () => {
    const { hub, opened, settle } = setup()
    const a = vi.fn()
    await hub.subscribe("db", "m", orgA, a)
    opened[0].resumeToken = { _data: "T1" }
    opened[0].emit("error", new Error("history lost"))
    await settle()
    expect(opened).toHaveLength(2)
    expect(opened[1].spec?.startAfter).toBeUndefined()
    expect(a).toHaveBeenCalledWith(null, "resync")
  })
})

describe("streamHub: server-filter bookkeeping (review round 1)", () => {
  it("a subscriber the open stream already covers leaves no join point behind to resume from later", async () => {
    const { hub, opened, settle } = setup()
    await hub.subscribe("db", "m", orgA, vi.fn())
    opened[0].resumeToken = { _data: "T1" }
    await hub.subscribe("db", "m", orgA, vi.fn()) // same filter: covered, nothing to do
    await settle()
    expect(opened).toHaveLength(1)

    opened[0].resumeToken = { _data: "T5" } // hours later
    await hub.subscribe("db", "m", orgB, vi.fn())
    await settle()
    expect(opened[1].spec?.startAfter).toEqual({ _data: "T5" }) // not the stale T1
  })

  it("a subscriber that joins while a reopen is opening is covered by the next one, from its own join point", async () => {
    const opened: Stream[] = []
    let release: (() => void) | undefined
    const hub = createStreamHub({
      serverSideFilters: true,
      reopenDelayMs: 0,
      openStream: async (_db, _model, spec) => {
        if (opened.length === 1) await new Promise<void>((r) => (release = r)) // the first reopen is slow
        const s = new Stream(spec)
        opened.push(s)
        return s
      },
    })
    const c = vi.fn()
    await hub.subscribe("db", "m", orgA, vi.fn())
    opened[0].resumeToken = { _data: "T1" }
    await hub.subscribe("db", "m", orgB, vi.fn())
    await vi.waitFor(() => expect(release).toBeDefined()) // reopen #1 (A+B) is opening…
    opened[0].resumeToken = { _data: "T2" }
    const orgC = { "fullDocument.org": "c" }
    await hub.subscribe("db", "m", orgC, c) // …when C joins, on the old stream at T2
    release!()
    await vi.waitFor(() => expect(opened).toHaveLength(3))
    expect(opened[1].spec?.pipeline).toEqual([{ $match: { $or: [orgA, orgB] } }])
    expect(opened[2].spec).toMatchObject({ pipeline: [{ $match: { $or: [orgA, orgB, orgC] } }], startAfter: { _data: "T2" } })
    opened[2].change(update("c"))
    expect(c).toHaveBeenCalledWith({ org: "c" }, "update")
  })
})

describe("streamHub: a stream that ends (review round 1)", () => {
  it("a close nobody here asked for — an invalidate — reconnects, in the default mode too", async () => {
    const { hub, opened, settle } = setup(false)
    const a = vi.fn()
    await hub.subscribe("db", "m", orgA, a)
    opened[0].emit("close")
    await settle()
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    opened[1].change(update("a"))
    expect(a).toHaveBeenCalledWith({ org: "a" }, "update")
  })

  it("a failure that keeps recurring backs off, and subscribers hear \"error\" once, on the third", async () => {
    const opened: Stream[] = []
    const hub = createStreamHub({
      reconnectDelayMs: 5,
      openStream: async () => {
        const s = new Stream()
        opened.push(s)
        setTimeout(() => s.emit("error", new Error("not authorized")), 0) // every stream fails at once
        return s
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const a = vi.fn()
    await hub.subscribe("db", "m", undefined, a)
    await new Promise((r) => setTimeout(r, 200))
    warn.mockRestore()
    // Delays 5, 10, 20, 40, 80 ms: about five reopens in 200 ms, not forty.
    expect(opened.length).toBeLessThanOrEqual(7)
    expect(opened.length).toBeGreaterThanOrEqual(3)
    expect(a.mock.calls.filter(([, type]) => type === "error")).toHaveLength(1)
    await hub.shutdown()
  })
})

describe("streamHub: after a stream fails (review round 2)", () => {
  it("default mode too: every subscriber re-reads once the stream is back", async () => {
    const { hub, opened, settle } = setup(false)
    const a = vi.fn()
    await hub.subscribe("db", "m", orgA, a)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    opened[0].emit("error", new Error("non-resumable"))
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    await settle()
    warn.mockRestore()
    expect(a).toHaveBeenCalledWith(null, "resync")
  })

  it("a reopen that keeps failing backs off, and subscribers hear \"error\" once, on the third", async () => {
    const opened: Stream[] = []
    let reopenAttempts = 0
    const hub = createStreamHub({
      serverSideFilters: true,
      reopenDelayMs: 0,
      reconnectDelayMs: 5,
      openStream: async (_db, _model, spec) => {
        if (opened.length >= 1) {
          reopenAttempts++
          throw new Error("cannot reach the server")
        }
        const s = new Stream(spec)
        opened.push(s)
        return s
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const a = vi.fn()
    await hub.subscribe("db", "m", orgA, a)
    opened[0].resumeToken = { _data: "T1" }
    await hub.subscribe("db", "m", orgB, vi.fn()) // needs a reopen, which keeps failing
    await new Promise((r) => setTimeout(r, 200))
    warn.mockRestore()
    // Delays 5, 10, 20, 40, 80 ms: about five attempts in 200 ms, not forty.
    expect(reopenAttempts).toBeGreaterThanOrEqual(3)
    expect(reopenAttempts).toBeLessThanOrEqual(7)
    expect(a.mock.calls.filter(([, type]) => type === "error")).toHaveLength(1)
    await hub.shutdown()
  })
})

describe("streamHub: the reopen backoff (review round 3)", () => {
  function failingReopens() {
    const opened: Stream[] = []
    let reopenAttempts = 0
    const hub = createStreamHub({
      serverSideFilters: true,
      reopenDelayMs: 0,
      reconnectDelayMs: 1000,
      openStream: async (_db, _model, spec) => {
        if (opened.length >= 1) {
          reopenAttempts++
          throw new Error("cannot reach the server")
        }
        const s = new Stream(spec)
        opened.push(s)
        return s
      },
    })
    return { hub, opened, attempts: () => reopenAttempts }
  }

  it("a subscribe during the backoff does not cut it short", async () => {
    const { hub, attempts } = failingReopens()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await hub.subscribe("db", "m", orgA, vi.fn())
    await hub.subscribe("db", "m", orgB, vi.fn()) // a reopen, which fails: next one in 1 s
    await vi.waitFor(() => expect(attempts()).toBe(1))
    await hub.subscribe("db", "m", { "fullDocument.org": "c" }, vi.fn()) // asks for another
    await new Promise((r) => setTimeout(r, 100))
    warn.mockRestore()
    expect(attempts()).toBe(1)
    await hub.shutdown()
  })

  it("the last unsubscribe, and shutdown, cancel the pending retry", async () => {
    vi.useFakeTimers()
    try {
      for (const end of ["unsubscribe", "shutdown"] as const) {
        const { hub, attempts } = failingReopens()
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const u1 = await hub.subscribe("db", "m", orgA, vi.fn())
        const u2 = await hub.subscribe("db", "m", orgB, vi.fn())
        await vi.advanceTimersByTimeAsync(5)
        expect(attempts()).toBe(1)
        if (end === "unsubscribe") {
          await u1()
          await u2()
        } else await hub.shutdown()
        warn.mockRestore()
        expect(vi.getTimerCount()).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("streamHub: review round 4", () => {
  it("with whenReady, a subscribe — and a joiner meanwhile — resolves only once the stream runs", async () => {
    let started!: () => void
    const ready = new Promise<void>((r) => (started = r))
    const hub = createStreamHub({ openStream: async () => new Stream(), whenReady: () => ready })
    const done: string[] = []
    const a = hub.subscribe("db", "m", orgA, vi.fn()).then(() => done.push("a"))
    await new Promise((r) => setTimeout(r, 10))
    const b = hub.subscribe("db", "m", orgB, vi.fn()).then(() => done.push("b")) // the stream is attached, not started
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toEqual([])
    started()
    await Promise.all([a, b])
    expect(done.sort()).toEqual(["a", "b"])
    await hub.shutdown()
  })

  it("after a reconnect, a subscriber that joined during it is re-read once a stream covers it", async () => {
    const opened: Stream[] = []
    let releaseReconnect: (() => void) | undefined
    const hub = createStreamHub({
      serverSideFilters: true,
      reopenDelayMs: 0,
      reconnectDelayMs: 0,
      openStream: async (_db, _model, spec) => {
        // The reconnect's open is slow, so a subscriber can join while it runs.
        if (opened.length === 1) await new Promise<void>((r) => (releaseReconnect = r))
        const s = new Stream(spec)
        s.resumeToken = { _data: `T${opened.length}` }
        opened.push(s)
        return s
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const log: string[] = []
    await hub.subscribe("db", "m", orgA, (_d, type) => log.push(`a:${type}`))
    opened[0].emit("error", new Error("non-resumable"))
    await vi.waitFor(() => expect(releaseReconnect).toBeDefined())
    const joining = hub.subscribe("db", "m", orgB, (_d, type) => log.push(`b:${type}@${opened.length}`))
    releaseReconnect!()
    await joining
    await vi.waitFor(() => expect(opened).toHaveLength(3)) // the reopen that covers B
    await new Promise((r) => setTimeout(r, 20))
    warn.mockRestore()
    expect(opened[1].spec!.pipeline).toEqual([{ $match: orgA }]) // the reconnect did not cover B…
    expect(opened[2].spec!.pipeline).toEqual([{ $match: { $or: [orgA, orgB] } }])
    // …so B re-reads again once the stream that covers it is attached, not only before it.
    expect(log).toContain("b:resync@3")
    await hub.shutdown()
  })

  it("a subscribe that fails after a shutdown does not remove the slot a later subscribe made", async () => {
    let failFirst!: (err: Error) => void
    let opens = 0
    const hub = createStreamHub({
      openStream: () =>
        opens++ === 0 ? new Promise<Stream>((_res, rej) => (failFirst = rej)) : Promise.resolve(new Stream()),
    })
    const first = hub.subscribe("db", "m", undefined, vi.fn()).catch(() => "failed")
    await new Promise((r) => setTimeout(r, 5))
    await hub.shutdown()
    await hub.subscribe("db", "m", undefined, vi.fn())
    expect(hub.size()).toBe(1)
    failFirst(new Error("no primary"))
    expect(await first).toBe("failed")
    expect(hub.size()).toBe(1)
    await hub.shutdown()
  })
})

describe("streamHub: review round 5", () => {
  it("a subscribe during a reconnect's backoff opens nothing; a stream that fails as it starts is reconnected too", async () => {
    const opened: Stream[] = []
    const hub = createStreamHub({
      reconnectDelayMs: 30,
      // Started on a "started" event; the first reconnect's stream fails instead.
      whenReady: (s: any) => new Promise<void>((r) => (s.once("started", r), s.once("error", r))),
      openStream: async () => {
        const s = new Stream()
        const n = opened.push(s)
        setTimeout(() => (n === 2 ? s.emit("error", new Error("second")) : s.emit("started")), 1)
        return s
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const a = vi.fn()
    await hub.subscribe("db", "m", undefined, a)
    opened[0].emit("error", new Error("first")) // the reconnect sleeps 30 ms…
    const b = vi.fn()
    await hub.subscribe("db", "m", undefined, b) // …a subscribe meanwhile resolves without opening (review round 9)…
    expect(opened).toHaveLength(1)
    // …the reconnect's stream fails as it starts, and the reconnect keeps going.
    await vi.waitFor(() => expect(opened).toHaveLength(3), { timeout: 500 })
    await new Promise((r) => setTimeout(r, 20))
    opened[2].change(update("x")) // the slot is live again
    warn.mockRestore()
    expect(a).toHaveBeenCalledWith(expect.anything(), "update")
    await hub.shutdown()
  })

  it("a reopened stream that fails as it starts backs off, and subscribers hear \"error\" on the third failure", async () => {
    const opened: Stream[] = []
    const hub = createStreamHub({
      serverSideFilters: true,
      reopenDelayMs: 0,
      reconnectDelayMs: 5,
      // Started on a "started" event; a stream the server rejects errors instead.
      whenReady: (s: any) => new Promise<void>((r) => (s.once("started", r), s.once("error", r))),
      openStream: async (_db, _model, spec) => {
        const s = new Stream(spec)
        opened.push(s)
        const rejected = JSON.stringify(spec?.pipeline ?? []).includes('"bad"')
        setTimeout(() => (rejected ? s.emit("error", new Error("$match rejected")) : s.emit("started")), 1)
        return s
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const a = vi.fn()
    await hub.subscribe("db", "m", orgA, a)
    opened[0].resumeToken = { _data: "T1" }
    hub.subscribe("db", "m", { "fullDocument.org": "bad" }, vi.fn()).catch(() => {})
    await vi.waitFor(() => expect(a.mock.calls.filter(([, t]) => t === "error")).toHaveLength(1), { timeout: 1000 })
    warn.mockRestore()
    await hub.shutdown()
  })
})

describe("streamHub: review round 10", () => {
  it("a subscriber that joins while a reopen opens, uncovered by the new stream, resumes from the reopen's start", async () => {
    const opened: Stream[] = []
    let gate: Promise<void> | undefined
    const hub = createStreamHub({
      serverSideFilters: true,
      reopenDelayMs: 0,
      reconnectDelayMs: 0,
      openStream: async (_db, _model, spec) => {
        if (gate) await gate
        const s = new Stream(spec)
        s.resumeToken = { _data: `T${opened.length}` }
        opened.push(s)
        return s
      },
    })
    const fC = { "fullDocument.org": "c" }
    const unsubA = await hub.subscribe("db", "m", orgA, vi.fn()) // s0: orgA
    await hub.subscribe("db", "m", fC, vi.fn()) // s1: orgA | c
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    let release!: () => void
    gate = new Promise<void>((r) => (release = r))
    await unsubA() // a reopen to c alone starts, resuming after s1 (T1), and waits at the gate…
    await new Promise((r) => setTimeout(r, 10))
    await hub.subscribe("db", "m", orgA, vi.fn()) // …B joins orgA, which s1 still covers
    gate = undefined
    release()
    await vi.waitFor(() => expect(opened).toHaveLength(4)) // s2 (c), then s3 for B
    expect(opened[2].spec!.pipeline).toEqual([{ $match: fC }])
    expect(opened[3].spec!.pipeline).toEqual([{ $match: { $or: [fC, orgA] } }])
    expect(opened[3].spec!.startAfter).toEqual({ _data: "T1" }) // from the reopen's start, not s2's position
    await hub.shutdown()
  })
})

describe("server-filter mode: review round F6", () => {
  // Filters were keyed with sorted keys, but equality on an embedded document is key-order
  // sensitive (in MongoDB and in the matcher): { zip, city } and { city, zip } shared a key, only
  // the first reached the stream's $match, and the second subscriber missed every event.
  it("two filters differing only in an embedded document's key order are both in the stream's $match", async () => {
    const { hub, opened, settle } = setup()
    const a: MongoFilter = { "fullDocument.addr": { zip: "1", city: "x" } }
    const b: MongoFilter = { "fullDocument.addr": { city: "x", zip: "1" } }
    const heardB = vi.fn()
    await hub.subscribe("db", "places", a, vi.fn())
    await hub.subscribe("db", "places", b, heardB)
    await settle()
    const match = opened.at(-1)!.spec!.pipeline!.find((stage: any) => stage.$match)!.$match as any
    expect(match.$or).toHaveLength(2)
    opened.at(-1)!.change({ operationType: "update", fullDocument: { addr: { city: "x", zip: "1" } }, documentKey: { _id: 1 } })
    expect(heardB).toHaveBeenCalledWith(expect.anything(), "update") // B hears its change
  })
})
