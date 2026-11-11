// The live-query engine's watch bookkeeping, with a fake transport: which watches open, which
// stay open, and which close, run by run.
import { beforeEach, describe, expect, it, vi } from "vitest"
import handlers, { query, v } from "@/server/handlers"
import { createLiveQueries, readRid } from "@/server/liveQuery"
import { createStreamHub, onChangeOrResync } from "@/server/streamHub"
import { EventEmitter } from "events"

let watchSet: string[] = []
let refuse = false

function harness() {
  const sent: any[] = []
  const opened: string[] = []
  const closed: string[] = []
  const fire = new Map<string, () => void>()
  const kill = new Map<string, () => void>()
  const live = createLiveQueries({
    debounceMs: 0,
    formatError: (e: any) => e.message,
    resolveActive: async () => ({ model: () => ({}) }),
    watchSpec: (model) => ({ key: model, model }),
    openWatch: async (spec, onEvent, onDead) => {
      opened.push(spec.model)
      fire.set(spec.model, onEvent)
      kill.set(spec.model, onDead)
      return { close: async () => void closed.push(spec.model) }
    },
  })
  live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
  const answered = (n: number) => vi.waitFor(() => expect(sent).toHaveLength(n))
  return { live, sent, opened, closed, fire, kill, answered }
}

beforeEach(() => {
  handlers.queries.clear()
  watchSet = []
  refuse = false
  query("lqDynamic", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      for (const model of watchSet) ctx.watch(model)
      if (refuse) throw new Error("Forbidden")
      return [...watchSet]
    },
  })
})

describe("live-query engine: watches follow every run", () => {
  it("keeps unchanged watches open, opens new ones and closes dropped ones", async () => {
    const h = harness()
    watchSet = ["a", "b"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)
    expect(h.opened).toEqual(["a", "b"])

    watchSet = ["b", "c"]
    h.fire.get("a")!()
    await h.answered(3) // the re-run, then a catch-up run for the newly opened "c" (it opens nothing new)
    expect(h.opened).toEqual(["a", "b", "c"])
    expect(h.closed).toEqual(["a"])

    h.fire.get("b")!()
    await h.answered(4)
    expect(h.opened).toEqual(["a", "b", "c"])
    expect(h.closed).toEqual(["a"])
  })

  it("a refused first run opens nothing", async () => {
    const h = harness()
    watchSet = ["a"]
    refuse = true
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)
    expect(h.sent[0].success).toBe(false)
    expect(h.opened).toEqual([])
  })

  it("a refused re-run closes every watch and stops answering", async () => {
    const h = harness()
    watchSet = ["a", "b"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)

    refuse = true
    h.fire.get("a")!()
    await h.answered(2)
    expect(h.sent[1].success).toBe(false)
    expect(h.closed.sort()).toEqual(["a", "b"])

    h.fire.get("b")!()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.sent).toHaveLength(2)
  })

  it("closing the socket closes its watches", async () => {
    const h = harness()
    watchSet = ["a"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)
    await h.live.close("s")
    expect(h.closed).toEqual(["a"])
  })
})

// ——— rid. A client re-asks after a write; without an id it cannot tell the answer it asked
// for from one already in flight, computed before the write.
let rows: string[] = []
let gate: Promise<void> | undefined

function registerRidQueries() {
  query("lqRows", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch("rows")
      const snapshot = [...rows] // read first…
      if (gate) await gate // …then stay in flight
      return snapshot
    },
  })
  query("lqPaged", {
    args: v.object({ paginationOpts: v.any().optional() }),
    handler: async (args, ctx) => {
      ctx.watch("rows")
      const from = args.paginationOpts?.next ? Number(args.paginationOpts.next) : 0
      const page = rows.slice(from, from + args.paginationOpts.limit)
      const end = from + page.length
      return { results: page, hasPrevious: false, hasNext: end < rows.length, next: String(end) }
    },
  })
}

describe("live-query engine: rid", () => {
  beforeEach(() => {
    rows = ["a"]
    gate = undefined
    registerRidQueries()
  })

  it("echoes the request's rid on its answer and on every re-run after it", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", name: "lqRows", args: {}, rid: "r1" })
    await h.answered(1)
    expect(h.sent[0]).toMatchObject({ type: "QueryResult", success: true, rid: "r1" })

    h.fire.get("rows")!()
    await h.answered(2)
    expect(h.sent[1].rid).toBe("r1")

    h.live.handle("s", { type: "query", name: "lqRows", args: {}, rid: 2 })
    await h.answered(3)
    h.fire.get("rows")!()
    await h.answered(4)
    expect(h.sent.slice(2).map((f) => f.rid)).toEqual([2, 2])
  })

  it("an answer already in flight keeps the old rid; the one asked for after a write has the new", async () => {
    const h = harness()
    let release!: () => void
    gate = new Promise((r) => (release = r))
    h.live.handle("s", { type: "query", name: "lqRows", args: {}, rid: "before" })
    await new Promise((r) => setTimeout(r, 10)) // run 1 has read ["a"] and is in flight

    rows = ["a", "b"] // the write
    h.live.handle("s", { type: "query", name: "lqRows", args: {}, rid: "after" })
    gate = undefined
    release()
    await h.answered(2)
    expect(h.sent.map((f) => [f.rid, f.data])).toEqual([
      ["before", ["a"]],
      ["after", ["a", "b"]],
    ])
  })

  it("a client that sends no rid gets frames without one", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", name: "lqRows", args: {} })
    await h.answered(1)
    expect("rid" in h.sent[0]).toBe(false)
  })

  it("paginated: the subscription's rid, a load's own rid, and the re-runs after it", async () => {
    rows = ["a", "b", "c"]
    const h = harness()
    h.live.handle("s", { type: "paginated-query", name: "lqPaged", args: { paginationOpts: { limit: 2 } }, rid: "p1" })
    await h.answered(1)
    expect(h.sent[0]).toMatchObject({ type: "PaginatedQueryResult", rid: "p1" })

    h.live.handle("s", { type: "paginated-query-load-next", rid: "p2" })
    await h.answered(2)
    expect(h.sent[1]).toMatchObject({ type: "PaginatedQueryPage", direction: "next", rid: "p2" })

    h.fire.get("rows")!()
    await h.answered(3)
    expect(h.sent[2]).toMatchObject({ type: "PaginatedQueryResult", rid: "p2" })
    expect(h.sent[2].data.results).toEqual(["a", "b", "c"])
  })

  it("ignores a rid that is not a short string or a finite number", () => {
    expect(readRid("x".repeat(201))).toBeUndefined()
    expect(readRid({ id: 1 })).toBeUndefined()
    expect(readRid(Number.NaN)).toBeUndefined()
    expect(readRid("ok")).toBe("ok")
    expect(readRid(0)).toBe(0)
  })
})

describe("live-query engine: answers that must, and must not, go out", () => {
  it("a change-triggered re-run replaced while its watches open sends nothing", async () => {
    const sent: any[] = []
    const fire = new Map<string, () => void>()
    let release: (() => void) | undefined
    let gated = false
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, onEvent) => {
        fire.set(spec.model, onEvent)
        if (spec.model === "slow" && !gated) {
          gated = true
          await new Promise<void>((r) => (release = r))
        }
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })

    watchSet = ["a"]
    live.handle("s", { type: "query", name: "lqDynamic", args: {}, rid: "A" })
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    watchSet = ["a", "slow"]
    fire.get("a")!() // the re-run's reconcile waits on the slow watch…
    await vi.waitFor(() => expect(release).toBeDefined())
    live.handle("s", { type: "query", name: "lqDynamic", args: {}, rid: "B" }) // …while B replaces it
    release!()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(sent.map((f) => f.rid)).toEqual(["A", "B"])
  })

  it("a load queued behind a re-run that tears the subscription down is still answered", async () => {
    let refusePages = false
    let releaseRefusal: (() => void) | undefined
    query("lqPagedRefusable", {
      args: v.object({ paginationOpts: v.any().optional() }),
      handler: async (_args, ctx) => {
        ctx.watch("rows")
        if (refusePages) {
          await new Promise<void>((r) => (releaseRefusal = r))
          throw new Error("Forbidden")
        }
        return { results: ["a"], hasPrevious: false, hasNext: true, next: "1" }
      },
    })
    const h = harness()
    h.live.handle("s", { type: "paginated-query", name: "lqPagedRefusable", args: { paginationOpts: { limit: 1 } } })
    await h.answered(1)

    refusePages = true
    h.fire.get("rows")!()
    await vi.waitFor(() => expect(releaseRefusal).toBeDefined()) // the re-run is running…
    h.live.handle("s", { type: "paginated-query-load-next", rid: "L1" }) // …the load waits behind it…
    releaseRefusal!() // …and the re-run is refused, tearing the subscription down
    await h.answered(3)
    expect(h.sent.slice(1).map((f) => [f.type, f.success, f.error, f.rid])).toEqual([
      ["PaginatedQueryResult", false, "Forbidden", undefined],
      ["PaginatedQueryPage", false, "No active paginated subscription", "L1"],
    ])
  })
})

describe("live-query engine: a watch that dies on its own", () => {
  it("is dropped and reopened, then a re-run reads what it missed", async () => {
    const h = harness()
    watchSet = ["a", "b"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)

    h.kill.get("a")!()
    await h.answered(2) // reopened first, then one re-run: no gap, no catch-up needed
    expect(h.opened).toEqual(["a", "b", "a"])
    expect(h.closed).toEqual(["a"])

    // The reopened watch is live: its events re-run the query.
    h.fire.get("a")!()
    await h.answered(3)
  })

  it("one that keeps dying backs off instead of spinning", async () => {
    const h = harness()
    watchSet = ["a"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)
    h.kill.get("a")!()
    await h.answered(2) // the first death retries at once (and re-runs once it is back)
    h.kill.get("a")!()
    await new Promise((r) => setTimeout(r, 300))
    expect(h.sent).toHaveLength(2) // the second waits (1 s)
    expect(h.opened).toEqual(["a", "a"])
  })

  it("a death reported for a watch already closed by the engine changes nothing", async () => {
    const h = harness()
    watchSet = ["a"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)
    const killA = h.kill.get("a")!
    await h.live.close("s")
    killA()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.opened).toEqual(["a"])
  })
})

describe("live-query engine: a watch that fails to open", () => {
  it("is retried, instead of leaving the subscription silently unwatched", async () => {
    const sent: any[] = []
    const opened: string[] = []
    const fire = new Map<string, () => void>()
    let failures = 1
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, onEvent) => {
        if (failures-- > 0) throw new Error("connection blip")
        opened.push(spec.model)
        fire.set(spec.model, onEvent)
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    watchSet = ["a"]
    live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await vi.waitFor(() => expect(opened).toEqual(["a"])) // the retry opened it
    warn.mockRestore()
    await vi.waitFor(() => expect(sent.length).toBe(2)) // then a re-run read what it missed
    fire.get("a")!()
    await vi.waitFor(() => expect(sent.length).toBe(3))
  })
})

describe("live-query engine: catching up after a new watch opens", () => {
  it("a write between a re-run's read and its new watch opening is read by one more run", async () => {
    let rows = ["p1"]
    let release: (() => void) | undefined
    query("lqMembersPosts", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        ctx.watch("members")
        ctx.watch(`posts-of-${watchSet.join(",")}`) // a filter built from what was read
        return [...rows]
      },
    })
    const sent: any[] = []
    const fire = new Map<string, () => void>()
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, onEvent) => {
        fire.set(spec.model, onEvent)
        if (spec.model === "posts-of-u1,u2") await new Promise<void>((r) => (release = r))
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })

    watchSet = ["u1"]
    live.handle("s", { type: "query", name: "lqMembersPosts", args: {} })
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    watchSet = ["u1", "u2"] // u2 joins: the re-run reads, then opens its new posts watch…
    fire.get("members")!()
    await vi.waitFor(() => expect(release).toBeDefined())
    rows = ["p1", "p-by-u2"] // …and u2 posts before it is open: no watch sees it
    release!()

    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(sent.map((f) => f.data)).toEqual([["p1"], ["p1"], ["p1", "p-by-u2"]])
  })

  it("a watch that changes on every run is caught up once, not forever", async () => {
    let n = 0
    query("lqEverChanging", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        ctx.watch(`since-${n++}`)
        return n
      },
    })
    const h = harness()
    h.live.handle("s", { type: "query", name: "lqEverChanging", args: {} })
    await h.answered(1)
    h.fire.get("since-0")!()
    await h.answered(3) // the re-run, and its one catch-up
    await new Promise((r) => setTimeout(r, 50))
    expect(h.sent).toHaveLength(3)
  })
})

describe("live-query engine: round-2 review", () => {
  it("a new subscription does not inherit the replaced one's pending catch-up", async () => {
    const sent: any[] = []
    const fire = new Map<string, () => void>()
    const live = createLiveQueries({
      debounceMs: 30,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, onEvent) => {
        fire.set(spec.model, onEvent)
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    watchSet = ["a"]
    live.handle("s", { type: "query", name: "lqDynamic", args: {}, rid: "A" })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    watchSet = ["a", "b"]
    fire.get("a")!() // A's re-run opens b, and schedules a catch-up…
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    live.handle("s", { type: "query", name: "lqDynamic", args: {}, rid: "B" }) // …that B replaces
    await vi.waitFor(() => expect(sent).toHaveLength(3))

    watchSet = ["a", "b", "c"]
    fire.get("a")!() // B's own re-run opens c: it must get its own catch-up
    await vi.waitFor(() => expect(sent).toHaveLength(5))
    expect(sent.map((f) => f.rid)).toEqual(["A", "A", "B", "B", "B"])
  })

  it("a pending retry is cancelled when the subscription is replaced", async () => {
    const h = harness()
    watchSet = ["a"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)
    h.kill.get("a")!()
    await h.answered(2) // the immediate retry, then its re-run
    h.kill.get("a")!() // the second death waits 1 s…
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {}, rid: "new" }) // …but a new subscription comes first
    await h.answered(3)
    const opens = h.opened.length
    await new Promise((r) => setTimeout(r, 1300))
    expect(h.sent).toHaveLength(3)
    expect(h.opened).toHaveLength(opens) // the old subscription's retry never reopened anything
  })

  it("a watch that lived a while had recovered: its next death retries at once", async () => {
    const sent: any[] = []
    const kill = new Map<string, () => void>()
    const live = createLiveQueries({
      debounceMs: 0,
      stableWatchMs: 50,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, _onEvent, onDead) => {
        kill.set(spec.model, onDead)
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    watchSet = ["a"]
    live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    kill.get("a")!()
    await vi.waitFor(() => expect(sent).toHaveLength(2)) // reopened, then re-run
    await new Promise((r) => setTimeout(r, 80)) // the reopened watch runs a while
    kill.get("a")!()
    await vi.waitFor(() => expect(sent).toHaveLength(3), { timeout: 500 }) // at once, not after 1 s
  })

  it("loading a page that watches something new does not re-read the whole window", async () => {
    let page = 0
    query("lqPagedWatchingIds", {
      args: v.object({ paginationOpts: v.any().optional() }),
      handler: async (args, ctx) => {
        const from = args.paginationOpts?.next ? Number(args.paginationOpts.next) : 0
        ctx.watch(`rows-${from}`) // a watch on this page's ids
        page++
        return { results: [from], hasPrevious: false, hasNext: true, next: String(from + 1) }
      },
    })
    const h = harness()
    h.live.handle("s", { type: "paginated-query", name: "lqPagedWatchingIds", args: { paginationOpts: { limit: 1 } } })
    await h.answered(1)
    h.live.handle("s", { type: "paginated-query-load-next" })
    await h.answered(2)
    await new Promise((r) => setTimeout(r, 50))
    expect(h.sent.map((f) => f.type)).toEqual(["PaginatedQueryResult", "PaginatedQueryPage"])
    expect(page).toBe(2)
  })
})

describe("live-query engine: round-3 review", () => {
  it("a re-run queued before a new subscription's first run does not run it early", async () => {
    let gate: Promise<void> | undefined
    let bCalls = 0
    query("lqGated", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        ctx.watch("a")
        if (gate) await gate
        return "A"
      },
    })
    query("lqCounted", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        ctx.watch("b")
        bCalls++
        return "B"
      },
    })
    const h = harness()
    h.live.handle("s", { type: "query", name: "lqGated", args: {}, rid: "A" })
    await h.answered(1)
    let release!: () => void
    gate = new Promise((r) => (release = r))
    h.live.handle("s", { type: "query", name: "lqGated", args: {}, rid: "A2" }) // busy at the gate…
    await new Promise((r) => setTimeout(r, 5))
    h.fire.get("a")!() // …a change queues a re-run behind it…
    await new Promise((r) => setTimeout(r, 5))
    h.live.handle("s", { type: "query", name: "lqCounted", args: {}, rid: "B" }) // …and B's first run behind that
    gate = undefined
    release()
    await h.answered(3)
    await new Promise((r) => setTimeout(r, 30))
    expect(bCalls).toBe(1)
    expect(h.sent.map((f) => f.rid)).toEqual(["A", "A2", "B"])
    expect(h.opened).toContain("b")
  })

  it("a new subscription starts with no backoff, even on the same watch", async () => {
    const h = harness()
    watchSet = ["a"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)
    h.kill.get("a")!()
    await h.answered(2)
    h.kill.get("a")!() // the 2nd death: a 1 s backoff for this subscription…
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {}, rid: "B" })
    await vi.waitFor(() => expect(h.sent.some((f) => f.rid === "B")).toBe(true))
    const before = h.sent.length
    h.kill.get("a")!() // …but B's first death retries at once
    await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(before), { timeout: 400 })
  })

  it("a watch that finally opened does not carry its failed opens into its first death", async () => {
    const sent: any[] = []
    const kill = new Map<string, () => void>()
    let failOpens = 1
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, _onEvent, onDead) => {
        if (failOpens-- > 0) throw new Error("blip")
        kill.set(spec.model, onDead)
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    watchSet = ["a"]
    live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await vi.waitFor(() => expect(kill.has("a")).toBe(true)) // the retry opened it
    await vi.waitFor(() => expect(sent.length).toBe(2))
    kill.get("a")!()
    await vi.waitFor(() => expect(sent.length).toBe(3), { timeout: 400 }) // at once, not after 1 s
    warn.mockRestore()
  })

  it("a run's new watches open in parallel", async () => {
    let inFlight = 0
    let most = 0
    const sent: any[] = []
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async () => {
        most = Math.max(most, ++inFlight)
        await new Promise((r) => setTimeout(r, 30))
        inFlight--
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    watchSet = ["a", "b", "c", "d"]
    live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(most).toBe(4)
  })

  it("shutdown closes every socket's watches in parallel", async () => {
    let closing = 0
    let most = 0
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async () => ({
        close: async () => {
          most = Math.max(most, ++closing)
          await new Promise((r) => setTimeout(r, 30))
          closing--
        },
      }),
    })
    const sent: any[] = []
    watchSet = ["a"]
    for (const id of ["s1", "s2", "s3"]) {
      live.open(id, { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
      live.handle(id, { type: "query", name: "lqDynamic", args: {} })
    }
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    await live.shutdown()
    expect(most).toBe(3)
  })
})

describe("live-query engine: review round 4", () => {
  it("a refused page load tears the subscription down, like a refused re-run", async () => {
    let refuseLoads = false
    query("lqPagedRefusedLoad", {
      args: v.object({ paginationOpts: v.any().optional() }),
      handler: async (args, ctx) => {
        ctx.watch("rows")
        if (refuseLoads && args.paginationOpts?.next) throw new Error("Forbidden")
        return { results: ["a"], hasPrevious: false, hasNext: true, next: "1" }
      },
    })
    const h = harness()
    h.live.handle("s", { type: "paginated-query", name: "lqPagedRefusedLoad", args: { paginationOpts: { limit: 1 } } })
    await h.answered(1)
    refuseLoads = true
    h.live.handle("s", { type: "paginated-query-load-next" })
    await h.answered(2)
    expect(h.sent[1]).toMatchObject({ type: "PaginatedQueryPage", success: false, error: "Forbidden" })
    expect(h.closed).toEqual(["rows"])
    h.fire.get("rows")!() // a write to what it watched: nothing more is sent
    await new Promise((r) => setTimeout(r, 30))
    expect(h.sent).toHaveLength(2)
  })
})

describe("live-query engine: review round 5", () => {
  it("a watch that can never start is retried alone: no handler runs, no frames", async () => {
    let runs = 0
    query("lqCountedRuns", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        runs++
        ctx.watch("bad")
        return runs
      },
    })
    const sent: any[] = []
    let opens = 0
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      // A pipeline the server rejects: the stream dies before it ever starts.
      openWatch: async (_spec, _onEvent, onDead) => {
        opens++
        onDead()
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    live.handle("s", { type: "query", name: "lqCountedRuns", args: {} })
    await vi.waitFor(() => expect(opens).toBe(2)) // opened with the run, retried once at once…
    await new Promise((r) => setTimeout(r, 200)) // …then backing off (1 s)
    expect(opens).toBe(2)
    expect(runs).toBe(1)
    expect(sent).toHaveLength(1)
    await live.shutdown()
  })
})

describe("live-query engine: review round 6", () => {
  it("shutdown works when taken off the object", async () => {
    const h = harness()
    watchSet = ["a"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)
    const { shutdown } = h.live
    await shutdown()
    expect(h.closed).toEqual(["a"])
  })

  it("counts for watches a re-run dropped are forgotten", async () => {
    const sent: any[] = []
    let fireA: (() => void) | undefined
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, onEvent) => {
        if (spec.model.startsWith("flaky")) throw new Error("blip")
        fireA = onEvent
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    watchSet = ["a"]
    live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    // Re-runs of ONE subscription whose watch key changes every run, on a flaky stream.
    for (let i = 0; i < 5; i++) {
      watchSet = ["a", `flaky${i}`]
      const before = sent.length
      fireA!()
      await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before))
    }
    watchSet = ["a"]
    const before = sent.length
    fireA!()
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before))
    warn.mockRestore()
    expect(live._socketState!("s")).toMatchObject({ watches: 1, specs: 1, openFailures: 0 })
    await live.shutdown()
  })

  it("a hub that keeps failing keeps its subscriber: the engine does not reset the hub's backoff", async () => {
    const streams: any[] = []
    const hub = createStreamHub({
      reconnectDelayMs: 5,
      openStream: async () => {
        const s: any = new EventEmitter()
        s.close = async () => {}
        // The first stream opens; it and every reconnect after it fail (no privilege, say).
        if (streams.length > 0) setTimeout(() => s.emit("error", new Error("not authorized")), 0)
        streams.push(s)
        return s
      },
    })
    let unsubscribes = 0
    const sent: any[] = []
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, onEvent) => {
        const unsubscribe = await hub.subscribe("db", spec.model, undefined, onChangeOrResync(onEvent))
        return { close: async () => void (unsubscribes++, await unsubscribe()) }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    watchSet = ["a"]
    live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    streams[0].emit("error", new Error("not authorized"))
    await vi.waitFor(() => expect(streams.length).toBeGreaterThanOrEqual(4)) // past the third failure: "error" sent
    await new Promise((r) => setTimeout(r, 20))
    warn.mockRestore()
    expect(unsubscribes).toBe(0) // still subscribed: the hub's reconnect owns the retry
    expect(hub.size()).toBe(1)
    await live.shutdown()
    await hub.shutdown()
  })
})

describe("live-query engine: a re-run's cost does not grow with scrolling (scalability review)", () => {
  it("re-reads at most maxRerunRows; past it the list shrinks to the cap, hasNext true, and loadNext continues", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `r${i}`)
    let calls = 0
    query("lqBigPaged", {
      args: v.object({ paginationOpts: v.any().optional() }),
      handler: async (args, ctx) => {
        calls++
        ctx.watch("rows")
        const from = args.paginationOpts?.next ? Number(args.paginationOpts.next) : 0
        const page = big.slice(from, from + args.paginationOpts.limit)
        const end = from + page.length
        return { results: page, hasPrevious: false, hasNext: end < big.length, next: String(end) }
      },
    })
    const sent: any[] = []
    let fire: (() => void) | undefined
    const live = createLiveQueries({
      debounceMs: 0,
      maxRerunRows: 100,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (_spec, onEvent) => ((fire = onEvent), { close: async () => {} }),
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    live.handle("s", { type: "paginated-query", name: "lqBigPaged", args: { paginationOpts: { limit: 50 } } })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    for (let i = 0; i < 9; i++) {
      live.handle("s", { type: "paginated-query-load-next" })
      await vi.waitFor(() => expect(sent).toHaveLength(i + 2))
    } // 500 rows loaded

    calls = 0
    fire!()
    await vi.waitFor(() => expect(sent).toHaveLength(11))
    const rerun = sent[10]
    expect(rerun.type).toBe("PaginatedQueryResult")
    expect(rerun.data.results).toHaveLength(100) // not 500
    expect(rerun.data.hasNext).toBe(true)
    expect(calls).toBe(1) // one 100-row page, not two 300-row ones

    live.handle("s", { type: "paginated-query-load-next" })
    await vi.waitFor(() => expect(sent).toHaveLength(12))
    expect(sent[11].data.results[0]).toBe("r100") // continues from the cap
    await live.shutdown()
  })

  // maxRerunRows was checked to be a number of at least 1 but not made whole (the per-socket
  // limits are): a fractional one (Number(process.env.X) = 100.5) reached the pager as its limit,
  // which mongo-cursor-pagination passes to cursor.limit(limit + 1) — not a whole number.
  it("a fractional maxRerunRows is taken whole: a re-run never asks the handler for a fractional page", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => `r${i}`)
    const limits: number[] = []
    query("lqFractionalCap", {
      args: v.object({ paginationOpts: v.any().optional() }),
      handler: async (args, ctx) => {
        ctx.watch("rows")
        limits.push(args.paginationOpts.limit)
        const from = args.paginationOpts?.next ? Number(args.paginationOpts.next) : 0
        const page = rows.slice(from, from + args.paginationOpts.limit)
        const end = from + page.length
        return { results: page, hasPrevious: false, hasNext: end < rows.length, next: String(end) }
      },
    })
    const sent: any[] = []
    let fire: (() => void) | undefined
    const live = createLiveQueries({
      debounceMs: 0,
      maxRerunRows: 100.5,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (_spec, onEvent) => ((fire = onEvent), { close: async () => {} }),
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    live.handle("s", { type: "paginated-query", name: "lqFractionalCap", args: { paginationOpts: { limit: 50 } } })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    for (let i = 0; i < 3; i++) {
      live.handle("s", { type: "paginated-query-load-next" })
      await vi.waitFor(() => expect(sent).toHaveLength(i + 2))
    } // 200 rows loaded
    limits.length = 0
    fire!()
    await vi.waitFor(() => expect(sent).toHaveLength(5))
    expect(limits.every(Number.isInteger)).toBe(true)
    expect(sent[4].data.results).toHaveLength(100)
    await live.shutdown()
  })
})

describe("live-query engine: backpressure (scalability review)", () => {
  it("holds re-runs while the connection is backed up, then re-runs once when it drains", async () => {
    let runs = 0
    query("lqCountedBackpressure", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        runs++
        ctx.watch("rows")
        return runs
      },
    })
    const sent: any[] = []
    let backedUp = false
    let fire: (() => void) | undefined
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (_spec, onEvent) => ((fire = onEvent), { close: async () => {} }),
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p), isBackedUp: () => backedUp })
    live.handle("s", { type: "query", name: "lqCountedBackpressure", args: {} })
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    backedUp = true
    for (let i = 0; i < 5; i++) {
      fire!()
      await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 150))
    expect(sent).toHaveLength(1) // nothing sent to a client that is not reading
    expect(runs).toBe(1) // and no handler run for it either

    backedUp = false
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 1000 }) // one re-run once drained
    await new Promise((r) => setTimeout(r, 250))
    expect(sent).toHaveLength(2)
    expect(sent[1].data).toBe(2)
    await live.shutdown()
  })
})

describe("live-query engine: review round 8", () => {
  it("a watch of the old subscription that dies before the new one's first run is not reopened under it", async () => {
    let releaseB!: () => void
    const gateB = new Promise<void>((r) => (releaseB = r))
    query("lqSlowB", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        ctx.watch("b")
        await gateB
        return "B"
      },
    })
    const h = harness()
    watchSet = ["w"]
    h.live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await h.answered(1)
    h.live.handle("s", { type: "query", name: "lqSlowB", args: {}, rid: "B" }) // B's first run is slow…
    await new Promise((r) => setTimeout(r, 10))
    h.kill.get("w")!() // …and A's watch dies meanwhile
    await new Promise((r) => setTimeout(r, 50))
    expect(h.opened).toEqual(["w"]) // not reopened for B, which never asked for it
    releaseB()
    await h.answered(2)
    expect(h.opened).toEqual(["w", "b"])
  })

  it("a change merged into a pending catch-up still gets a catch-up of its own", async () => {
    const sent: any[] = []
    const fire = new Map<string, () => void>()
    const live = createLiveQueries({
      debounceMs: 150,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, onEvent) => (fire.set(spec.model, onEvent), { close: async () => {} }),
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    watchSet = ["a"]
    live.handle("s", { type: "query", name: "lqDynamic", args: {} })
    await vi.waitFor(() => expect(sent).toHaveLength(1), { interval: 5 })
    watchSet = ["a", "b"]
    fire.get("a")!() // a re-run that opens b: its catch-up is now pending (150 ms)
    await vi.waitFor(() => expect(sent).toHaveLength(2), { interval: 5 })
    watchSet = ["a", "b", "c"]
    fire.get("a")!() // a real change, merged into that pending run, which opens c
    await vi.waitFor(() => expect(sent).toHaveLength(3), { interval: 5 })
    await vi.waitFor(() => expect(sent).toHaveLength(4), { timeout: 1000, interval: 5 }) // c's catch-up
    await new Promise((r) => setTimeout(r, 300))
    expect(sent).toHaveLength(4)
    await live.shutdown()
  })
})

describe("live-query engine: review round 9", () => {
  it("re-runs and page loads keep every paginationOpts field the client sent (paginatedField, fields, …)", async () => {
    const seen: any[] = []
    query("lqPagedOpts", {
      args: v.object({ paginationOpts: v.any().optional() }),
      handler: async (args, ctx) => {
        ctx.watch("rows")
        seen.push(args.paginationOpts)
        const from = args.paginationOpts?.next ? Number(args.paginationOpts.next) : 0
        return { results: ["a", "b", "c", "d"].slice(from, from + 2), hasPrevious: false, hasNext: from + 2 < 4, next: String(from + 2) }
      },
    })
    const h = harness()
    const asked = { limit: 2, paginatedField: "createdAt", fields: { title: 1 }, sortAscending: true }
    h.live.handle("s", { type: "paginated-query", name: "lqPagedOpts", args: { paginationOpts: asked } })
    await h.answered(1)
    h.live.handle("s", { type: "paginated-query-load-next" })
    await h.answered(2)
    h.fire.get("rows")!()
    await h.answered(3)
    for (const opts of seen) expect(opts).toMatchObject({ paginatedField: "createdAt", fields: { title: 1 }, sortAscending: true })
    expect(seen[1]).toMatchObject({ limit: 2, next: "2" }) // the load's own keys still set by the engine
  })
})

describe("live-query engine: backpressure with many slow clients (review round 9)", () => {
  it("one drain timer for the engine, not one per backed-up socket", async () => {
    const sent: any[] = []
    const fire: (() => void)[] = []
    let backedUp = false
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (_spec, onEvent) => (fire.push(onEvent), { close: async () => {} }),
    })
    watchSet = ["a"]
    for (const id of ["s1", "s2", "s3"]) {
      live.open(id, { headers: {}, isOpen: () => true, send: (p) => void sent.push(p), isBackedUp: () => backedUp })
      live.handle(id, { type: "query", name: "lqDynamic", args: {} })
    }
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    const intervals = vi.spyOn(globalThis, "setInterval")
    try {
      backedUp = true
      for (const f of fire) f()
      await new Promise((r) => setTimeout(r, 50))
      expect(intervals).toHaveBeenCalledTimes(1)
      backedUp = false
      await vi.waitFor(() => expect(sent).toHaveLength(6), { timeout: 1000 }) // each socket re-runs once
    } finally {
      intervals.mockRestore()
    }
    await live.shutdown()
  })
})

describe("live-query engine: review round 10", () => {
  it("a subscription that began at a cursor is re-read from that cursor, not from the top", async () => {
    const seen: any[] = []
    query("lqPagedFromCursor", {
      args: v.object({ paginationOpts: v.any().optional() }),
      handler: async (args, ctx) => {
        ctx.watch("rows")
        seen.push(args.paginationOpts)
        const from = args.paginationOpts?.next ? Number(args.paginationOpts.next) : 0
        const rows = ["r0", "r1", "r2", "r3", "r4", "r5"]
        return { results: rows.slice(from, from + 2), hasPrevious: from > 0, hasNext: from + 2 < rows.length, next: String(from + 2) }
      },
    })
    const h = harness()
    h.live.handle("s", { type: "paginated-query", name: "lqPagedFromCursor", args: { paginationOpts: { limit: 2, next: "2" } } })
    await h.answered(1)
    expect(h.sent[0].data.results).toEqual(["r2", "r3"])
    h.fire.get("rows")!()
    await h.answered(2)
    expect(h.sent[1].data.results).toEqual(["r2", "r3"]) // not r0, r1
    expect(seen[1]).toMatchObject({ next: "2" })
  })

  it("each load is answered with its own rid, even when one waits behind another", async () => {
    rows = ["a", "b", "c", "d", "e", "f"]
    registerRidQueries()
    const h = harness()
    h.live.handle("s", { type: "paginated-query", name: "lqPaged", args: { paginationOpts: { limit: 2 } }, rid: "p" })
    await h.answered(1)
    h.live.handle("s", { type: "paginated-query-load-next", rid: "L1" })
    h.live.handle("s", { type: "paginated-query-load-next", rid: "L2" }) // queued behind L1
    await h.answered(3)
    expect(h.sent.slice(1).map((f) => f.rid)).toEqual(["L1", "L2"])
  })
})

describe("live-query engine: review round 11", () => {
  // A pager over r0..r9 that understands both cursors, as mongo-cursor-pagination does.
  function registerTwoWayPager(seen: any[]) {
    query("lqTwoWay", {
      args: v.object({ paginationOpts: v.any().optional() }),
      handler: async (args, ctx) => {
        ctx.watch("rows")
        const o = args.paginationOpts ?? {}
        seen.push(o)
        const rows = Array.from({ length: 10 }, (_, i) => `r${i}`)
        let from: number
        let to: number
        if (o.previous) {
          to = Number(o.previous)
          from = Math.max(0, to - o.limit)
        } else {
          from = o.next ? Number(o.next) : 0
          to = Math.min(rows.length, from + o.limit)
        }
        return { results: rows.slice(from, to), previous: String(from), hasPrevious: from > 0, next: String(to), hasNext: to < rows.length }
      },
    })
  }

  it("a window that began before a cursor and grew forward is re-read as it is", async () => {
    registerTwoWayPager([])
    const h = harness()
    h.live.handle("s", { type: "paginated-query", name: "lqTwoWay", args: { paginationOpts: { limit: 2, previous: "6" } } })
    await h.answered(1)
    expect(h.sent[0].data.results).toEqual(["r4", "r5"])
    h.live.handle("s", { type: "paginated-query-load-next" })
    await h.answered(2)
    h.fire.get("rows")!()
    await h.answered(3)
    expect(h.sent[2].data.results).toEqual(["r4", "r5", "r6", "r7"]) // not r2..r5
  })

  it("a window that began at a cursor and grew upward is re-read with the rows above it", async () => {
    registerTwoWayPager([])
    const h = harness()
    h.live.handle("s", { type: "paginated-query", name: "lqTwoWay", args: { paginationOpts: { limit: 2, next: "4" } } })
    await h.answered(1)
    h.live.handle("s", { type: "paginated-query-load-previous" })
    await h.answered(2)
    expect(h.sent[1].data.results).toEqual(["r2", "r3"])
    h.fire.get("rows")!()
    await h.answered(3)
    expect(h.sent[2].data.results).toEqual(["r2", "r3", "r4", "r5"]) // not r4..r7
  })
})

describe("live-query engine: page size when the client sends none (review round 12)", () => {
  it("loads come in the handler's own page size; a non-numeric limit does not read the whole list", async () => {
    const seen: any[] = []
    query("lqDefaultLimit", {
      args: v.object({ paginationOpts: v.any().optional() }),
      handler: async (args, ctx) => {
        ctx.watch("rows")
        seen.push(args.paginationOpts)
        const limit = typeof args.paginationOpts?.limit === "number" ? args.paginationOpts.limit : 50
        const from = args.paginationOpts?.next ? Number(args.paginationOpts.next) : 0
        const total = 500
        const to = Math.min(total, from + limit)
        return { results: Array.from({ length: to - from }, (_, i) => from + i), hasPrevious: from > 0, hasNext: to < total, next: String(to) }
      },
    })
    for (const asked of [{}, { limit: "lots" }]) {
      seen.length = 0
      const h = harness()
      h.live.handle("s", { type: "paginated-query", name: "lqDefaultLimit", args: { paginationOpts: asked } })
      await h.answered(1)
      h.live.handle("s", { type: "paginated-query-load-next" })
      await h.answered(2)
      expect(h.sent[1].data.results).toHaveLength(50) // the handler's page size, not 10
      h.fire.get("rows")!()
      await h.answered(3)
      expect(h.sent[2].data.results).toHaveLength(100) // the window, not all 500
    }
  })
})

describe("live-query engine: review round F16", () => {
  // attachWs builds one header view per socket and every run of the socket got that object, so a
  // handler normalising a header in place (ctx.headers.set("x-tenant", …)) changed what every later
  // run on the socket — and the DB resolver — read: a request could land in another tenant's
  // database. Each run gets its own copy, which its resolver call and its handler share.
  it("a handler's write to ctx.headers stays with its own run", async () => {
    const { headerView } = await import("@/server/headers")
    const seenByHandler: (string | null)[] = []
    const seenByResolver: (string | null)[] = []
    let fire: (() => void) | undefined
    query("lqHeaderWrite", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        ctx.watch("rows")
        seenByHandler.push(ctx.headers.get("x-tenant"))
        ctx.headers.set("x-tenant", "mutated")
        return 1
      },
    })
    const sent: any[] = []
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async (headers: any) => (seenByResolver.push(headers.get("x-tenant")), { model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (_spec, onEvent) => ((fire = onEvent), { close: async () => {} }),
    })
    live.open("s", { headers: headerView({ "x-tenant": "t1" }), isOpen: () => true, send: (p) => void sent.push(p) })
    live.handle("s", { type: "query", name: "lqHeaderWrite", args: {} })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    fire!()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(seenByHandler).toEqual(["t1", "t1"])
    expect(seenByResolver).toEqual(["t1", "t1"])
    await live.shutdown()
  })
})
