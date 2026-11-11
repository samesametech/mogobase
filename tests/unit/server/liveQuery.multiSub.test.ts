// Many live subscriptions on one socket (4.0.0): a query / paginated-query with a client-chosen
// `sid` gets a slot of its own, beside the socket's default one (no sid). Each slot owns its
// watches, backoff, catch-up, window and run queue; frames for it echo its sid.
import { beforeEach, describe, expect, it, vi } from "vitest"
import handlers, { query, v } from "@/server/handlers"
import { createLiveQueries, type LiveQueryOptions } from "@/server/liveQuery"
import { createStreamHub, onChangeOrResync } from "@/server/streamHub"
import { makeFakeStreamFactory } from "../../helpers/fakeChangeStream"

const failing = new Set<string>()
const gates = new Map<string, Promise<void>>()
let inFlight = 0
let maxInFlight = 0

function harness(extra: Partial<LiveQueryOptions> = {}, backedUp = () => false) {
  const sent: any[] = []
  const opened: string[] = []
  const closed: string[] = []
  const fire = new Map<string, (() => void)[]>()
  const live = createLiveQueries({
    debounceMs: 0,
    formatError: (e: any) => e.message,
    resolveActive: async () => ({ model: () => ({}) }),
    watchSpec: (model) => ({ key: model, model }),
    openWatch: async (spec, onEvent) => {
      opened.push(spec.model)
      fire.set(spec.model, [...(fire.get(spec.model) ?? []), onEvent])
      return { close: async () => void closed.push(spec.model) }
    },
    ...extra,
  })
  live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p), isBackedUp: backedUp })
  const change = (model: string) => fire.get(model)?.forEach((f) => f())
  const frames = (sid?: unknown) => sent.filter((f) => f.sid === sid)
  return { live, sent, opened, closed, change, frames }
}

beforeEach(() => {
  handlers.queries.clear()
  failing.clear()
  gates.clear()
  inFlight = 0
  maxInFlight = 0
  query("ms.watch", {
    args: v.object({ model: v.string() }),
    handler: async ({ model }, ctx) => {
      ctx.watch(model)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await gates.get(model)
        if (failing.has(model)) throw new Error(`${model} refused`)
        return { model, at: Date.now() }
      } finally {
        inFlight--
      }
    },
  })
  query("ms.page", {
    args: v.object({ model: v.string(), paginationOpts: v.any() }),
    handler: async ({ model, paginationOpts }, ctx) => {
      ctx.watch(model)
      const from = paginationOpts?.next ? Number(paginationOpts.next) : 0
      const rows = [0, 1, 2, 3, 4, 5].slice(from, from + (paginationOpts?.limit ?? 2)).map((_id) => ({ _id }))
      const end = from + rows.length
      return { results: rows, hasNext: end < 6, next: end < 6 ? String(end) : undefined, hasPrevious: from > 0, previous: from ? String(from) : undefined }
    },
  })
})

describe("many subscriptions on one socket", () => {
  it("two subscriptions update independently, each frame carrying its sid", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a" } })
    h.live.handle("s", { type: "query", sid: 2, name: "ms.watch", args: { model: "b" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))
    expect(h.frames("A")[0].data.model).toBe("a")
    expect(h.frames(2)[0].data.model).toBe("b")
    h.change("a")
    await vi.waitFor(() => expect(h.frames("A")).toHaveLength(2))
    expect(h.frames(2)).toHaveLength(1) // b's subscription did not re-run
  })

  it("a sid replaces only its own subscription; the default one (no sid) is a slot of its own", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", name: "ms.watch", args: { model: "d" } })
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a1" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a2" } })
    await vi.waitFor(() => expect(h.frames("A")).toHaveLength(2))
    await vi.waitFor(() => expect(h.closed).toEqual(["a1"]))
    expect(h.frames(undefined)).toHaveLength(1)
    expect(h.frames(undefined)[0]).not.toHaveProperty("sid")
    h.change("d")
    await vi.waitFor(() => expect(h.frames(undefined)).toHaveLength(2)) // the default one is still live
  })

  it("one failing subscription tears down only itself; its sibling stays live", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a" } })
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))
    failing.add("a")
    h.change("a")
    await vi.waitFor(() => expect(h.frames("A").at(-1).success).toBe(false))
    expect(h.closed).toEqual(["a"])
    h.change("b")
    await vi.waitFor(() => expect(h.frames("B")).toHaveLength(2))
    expect(h.frames("B").every((f) => f.success)).toBe(true)
    expect(h.live._socketState!("s")).toMatchObject({ subscriptions: 1, watches: 1 })
  })

  it("unsubscribe ends one subscription, acks with its sid, and sends nothing more for it", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a" } })
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))
    h.live.handle("s", { type: "unsubscribe", sid: "A", rid: 7 })
    await vi.waitFor(() => expect(h.closed).toEqual(["a"]))
    expect(h.sent.at(-1)).toEqual({ type: "Unsubscribed", sid: "A", rid: 7 })
    h.change("a")
    h.change("b")
    await vi.waitFor(() => expect(h.frames("B")).toHaveLength(2))
    expect(h.frames("A").filter((f) => f.type === "QueryResult")).toHaveLength(1)
    expect(h.live._socketState!("s")).toMatchObject({ subscriptions: 1 })
  })

  it("past maxSubscriptionsPerSocket a new sid is refused with an error frame carrying it; a known sid is still replaced", async () => {
    const h = harness({ maxSubscriptionsPerSocket: 2 })
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a" } })
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
    h.live.handle("s", { type: "paginated-query", sid: "C", rid: "r", name: "ms.page", args: { model: "c" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(3))
    const refused = h.frames("C")[0]
    expect(refused).toMatchObject({ type: "PaginatedQueryResult", success: false, sid: "C", rid: "r" })
    expect(refused.error).toMatch(/at most 2/)
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b2" } })
    await vi.waitFor(() => expect(h.frames("B")).toHaveLength(2))
    expect(h.frames("B")[1].success).toBe(true)
  })

  it("a query and a paginated query side by side: loads go to the sid's paginated subscription", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", sid: "Q", name: "ms.watch", args: { model: "q" } })
    h.live.handle("s", { type: "paginated-query", sid: "P", name: "ms.page", args: { model: "p", paginationOpts: { limit: 2 } } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))
    h.live.handle("s", { type: "paginated-query-load-next", sid: "P" })
    await vi.waitFor(() => expect(h.frames("P")).toHaveLength(2))
    expect(h.frames("P")[1]).toMatchObject({ type: "PaginatedQueryPage", direction: "next", success: true })
    expect(h.frames("P")[1].data.results.map((r: any) => r._id)).toEqual([2, 3])
    h.live.handle("s", { type: "paginated-query-load-next", sid: "Q" }) // Q is not paginated
    await vi.waitFor(() => expect(h.frames("Q")).toHaveLength(2))
    expect(h.frames("Q")[1]).toMatchObject({ type: "PaginatedQueryPage", success: false, sid: "Q" })
    h.change("p")
    await vi.waitFor(() => expect(h.frames("P")).toHaveLength(3))
    expect(h.frames("P")[2].data.results).toHaveLength(4) // the re-run reads the loaded window
  })

  it("backpressure is per socket: every subscription a change reaches is held, and re-runs once on drain", async () => {
    let backed = false
    const h = harness({}, () => backed)
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a" } })
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
    h.live.handle("s", { type: "query", sid: "C", name: "ms.watch", args: { model: "c" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(3))
    backed = true
    for (let i = 0; i < 3; i++) {
      h.change("a")
      h.change("b")
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(h.sent).toHaveLength(3) // held: no run, no frame
    backed = false
    await vi.waitFor(() => expect(h.sent).toHaveLength(5))
    await new Promise((r) => setTimeout(r, 150))
    expect(h.frames("A")).toHaveLength(2)
    expect(h.frames("B")).toHaveLength(2)
    expect(h.frames("C")).toHaveLength(1) // no change reached it
  })

  it("a slow handler does not hold up its siblings; runs per socket are capped", async () => {
    const h = harness({ maxConcurrentRunsPerSocket: 2 })
    let open!: () => void
    gates.set("slow", new Promise<void>((r) => (open = r)))
    h.live.handle("s", { type: "query", sid: "S", name: "ms.watch", args: { model: "slow" } })
    h.live.handle("s", { type: "query", sid: "F", name: "ms.watch", args: { model: "fast" } })
    await vi.waitFor(() => expect(h.frames("F")).toHaveLength(1)) // answered while S still runs
    expect(h.frames("S")).toHaveLength(0)
    let open2!: () => void
    gates.set("slow2", new Promise<void>((r) => (open2 = r)))
    h.live.handle("s", { type: "query", sid: "S2", name: "ms.watch", args: { model: "slow2" } })
    h.live.handle("s", { type: "query", sid: "T", name: "ms.watch", args: { model: "third" } })
    await new Promise((r) => setTimeout(r, 30))
    expect(maxInFlight).toBe(2) // T waits for a turn
    expect(h.frames("T")).toHaveLength(0)
    open()
    open2()
    await vi.waitFor(() => expect(h.frames("T")).toHaveLength(1))
  })

  it("closing the socket ends every subscription and closes every watch", async () => {
    const h = harness()
    for (const sid of ["A", "B", "C"]) h.live.handle("s", { type: "query", sid, name: "ms.watch", args: { model: sid.toLowerCase() } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(3))
    await h.live.close("s")
    expect(h.closed.sort()).toEqual(["a", "b", "c"])
    expect(h.live._socketState!("s")).toBeUndefined()
    h.change("a")
    await new Promise((r) => setTimeout(r, 20))
    expect(h.sent).toHaveLength(3)
  })

  it("an unusable sid is refused, not taken for the default subscription", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", sid: { nested: 1 }, rid: 1, name: "ms.watch", args: { model: "a" } })
    h.live.handle("s", { type: "query", sid: "x".repeat(65), name: "ms.watch", args: { model: "a" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))
    expect(h.sent[0]).toMatchObject({ type: "QueryResult", success: false, rid: 1 })
    expect(h.sent[0].error).toMatch(/Invalid sid/)
    expect(h.sent[0]).not.toHaveProperty("sid")
    expect(h.opened).toEqual([])
  })

  it("two subscriptions watching the same filter on the hub: one leaving keeps the other's", async () => {
    const { factory, opened } = makeFakeStreamFactory()
    const hub = createStreamHub({ openStream: (_db, model) => Promise.resolve(factory(model)) })
    const h = harness({
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec, onEvent) => {
        const unsub = await hub.subscribe("db", spec.model, { "fullDocument.org": "o1" }, onChangeOrResync(onEvent))
        return { close: unsub }
      },
    })
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "orders" } })
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "orders" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))
    h.live.handle("s", { type: "unsubscribe", sid: "A" })
    await new Promise((r) => setTimeout(r, 10))
    expect(opened.orders).toHaveLength(1)
    expect(opened.orders[0].closed).toBe(false) // B still holds its hub subscription
    opened.orders[0].emitChange({ _id: 1, org: "o1" })
    await vi.waitFor(() => expect(h.frames("B")).toHaveLength(2))
    h.live.handle("s", { type: "unsubscribe", sid: "B" })
    await vi.waitFor(() => expect(opened.orders[0].closed).toBe(true)) // the last one out closes it
  })
})

describe("many subscriptions: review round F1", () => {
  // A replaced subscription's own failure still answers with the sid; the guide said any
  // success: false for a sid ended it, so a client dropped the live replacement. Only a frame
  // with `ended: true` ends a sid's subscription now.
  it("a failure that ends the sid's subscription says ended: true; one from a replaced subscription does not", async () => {
    const h = harness()
    let open!: () => void
    gates.set("old", new Promise<void>((r) => (open = r)))
    failing.add("old")
    h.live.handle("s", { type: "query", sid: "T", rid: 1, name: "ms.watch", args: { model: "old" } })
    h.live.handle("s", { type: "query", sid: "T", rid: 2, name: "ms.watch", args: { model: "new" } })
    open()
    await vi.waitFor(() => expect(h.frames("T")).toHaveLength(2))
    const [oldAnswer, newAnswer] = h.frames("T")
    expect(oldAnswer).toMatchObject({ success: false, rid: 1 })
    expect(oldAnswer).not.toHaveProperty("ended") // the request's answer; "T" is alive
    expect(newAnswer).toMatchObject({ success: true, rid: 2 })
    failing.add("new")
    h.change("new")
    await vi.waitFor(() => expect(h.frames("T")).toHaveLength(3))
    expect(h.frames("T")[2]).toMatchObject({ success: false, ended: true }) // now "T" is gone
  })

  it("the default subscription's frames are as they always were: no ended field", async () => {
    const h = harness()
    failing.add("d")
    h.live.handle("s", { type: "query", name: "ms.watch", args: { model: "d" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect(h.sent[0]).not.toHaveProperty("ended")
  })

  it("a limit refusal says ended: true (nothing is subscribed for that sid)", async () => {
    const h = harness({ maxSubscriptionsPerSocket: 1 })
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a" } })
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
    await vi.waitFor(() => expect(h.frames("B")).toHaveLength(1))
    expect(h.frames("B")[0]).toMatchObject({ success: false, ended: true })
  })

  // The run cap is for handler runs (the database pool). Held across the watch opens too, which
  // can wait seconds for a stream to start, it kept siblings' first answers waiting behind them.
  it("a turn is held for the handler run only, not while a subscription's watches open", async () => {
    let releaseOpen!: () => void
    const opening = new Promise<void>((r) => (releaseOpen = r))
    const sent: any[] = []
    const live = createLiveQueries({
      debounceMs: 0,
      maxConcurrentRunsPerSocket: 1,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (spec) => {
        if (spec.model === "coldstream") await opening // a stream slow to start
        return { close: async () => {} }
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "coldstream" } })
    live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
    await vi.waitFor(() => expect(sent.some((f) => f.sid === "B")).toBe(true)) // B answered while A's watch opens
    expect(sent.some((f) => f.sid === "A")).toBe(false)
    releaseOpen()
    await vi.waitFor(() => expect(sent.some((f) => f.sid === "A")).toBe(true))
  })

  it("a load refused for an unusable sid carries its direction", async () => {
    const h = harness()
    h.live.handle("s", { type: "paginated-query-load-previous", sid: "x".repeat(65) })
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect(h.sent[0]).toMatchObject({ type: "PaginatedQueryPage", success: false, direction: "previous" })
  })

  it("sid: null is no sid (the default subscription), as a JSON client writes it", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", sid: null, name: "ms.watch", args: { model: "a" } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect(h.sent[0]).toMatchObject({ type: "QueryResult", success: true })
    expect(h.sent[0]).not.toHaveProperty("sid")
  })
})

describe("many subscriptions: review round F2", () => {
  // The ended frame went out only after teardown had closed the watches; the slot was already
  // gone from the socket, so a re-subscribe of the sid in between made a new slot — and the late
  // `ended: true` then told the client its live replacement was over.
  it("the ended frame goes out before the watches finish closing, so a re-subscribe made meanwhile is not the one it ends", async () => {
    let finishClose!: () => void
    const closing = new Promise<void>((r) => (finishClose = r))
    const sent: any[] = []
    const fires: (() => void)[] = []
    const live = createLiveQueries({
      debounceMs: 0,
      formatError: (e: any) => e.message,
      resolveActive: async () => ({ model: () => ({}) }),
      watchSpec: (model) => ({ key: model, model }),
      openWatch: async (_spec, onEvent) => {
        fires.push(onEvent)
        return { close: () => closing } // a stream slow to close
      },
    })
    live.open("s", { headers: {}, isOpen: () => true, send: (p) => void sent.push(p) })
    live.handle("s", { type: "query", sid: "x", rid: 1, name: "ms.watch", args: { model: "a" } })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    failing.add("a")
    fires[0]()
    await vi.waitFor(() => expect(sent.some((f) => f.ended)).toBe(true)) // sent while the close still hangs
    expect(sent.at(-1)).toMatchObject({ sid: "x", rid: 1, ended: true })
    failing.delete("a")
    live.handle("s", { type: "query", sid: "x", rid: 2, name: "ms.watch", args: { model: "b" } })
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ sid: "x", rid: 2, success: true }))
    finishClose()
    await new Promise((r) => setTimeout(r, 20))
    expect(sent.filter((f) => f.ended)).toHaveLength(1) // nothing more ended the live "x"
  })

  // Runs waiting for a turn (or in a slot's queue) ran their handlers after the socket closed or
  // the sid was unsubscribed — every answer dropped, the database work done anyway.
  it("runs of an unsubscribed sid or a closed socket do not run their handlers once they get a turn", async () => {
    const h = harness({ maxConcurrentRunsPerSocket: 1 })
    let open!: () => void
    gates.set("busy", new Promise<void>((r) => (open = r)))
    h.live.handle("s", { type: "query", sid: "busy", name: "ms.watch", args: { model: "busy" } })
    await vi.waitFor(() => expect(inFlight).toBe(1))
    for (const sid of ["w1", "w2", "w3"]) h.live.handle("s", { type: "query", sid, name: "ms.watch", args: { model: sid } })
    h.live.handle("s", { type: "unsubscribe", sid: "w1" })
    h.live.handle("s", { type: "unsubscribe", sid: "w2" })
    const ran: string[] = []
    const spy = vi.spyOn(handlers, "_runQuery").mockImplementation(async (_n: string, args: any) => {
      ran.push(args?.model)
      return null
    })
    open()
    await vi.waitFor(() => expect(h.frames("w3")).toHaveLength(1))
    expect(ran).toEqual(["w3"]) // w1 and w2 never ran
    spy.mockRestore()
  })
})

describe("many subscriptions: review round F3", () => {
  // Four handlers that never settle held every turn: the whole tab stopped, first answers
  // included. A turn held past turnTimeoutMs is given up (the run goes on, uncapped).
  it("a turn held too long is given up, so a hung handler cannot stop the rest of the socket", async () => {
    const h = harness({ maxConcurrentRunsPerSocket: 1, turnTimeoutMs: 30 })
    gates.set("hung", new Promise<void>(() => {})) // never settles
    h.live.handle("s", { type: "query", sid: "H", name: "ms.watch", args: { model: "hung" } })
    await vi.waitFor(() => expect(inFlight).toBe(1))
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
    await vi.waitFor(() => expect(h.frames("B")).toHaveLength(1), { timeout: 1000 })
  })

  // Turns were first come, first served: a query the user was waiting for queued behind the
  // change-triggered re-runs of every sibling in a write burst.
  it("a run the client asked for goes ahead of change-triggered re-runs waiting for a turn", async () => {
    const h = harness({ maxConcurrentRunsPerSocket: 1 })
    for (const sid of ["r1", "r2", "r3"]) h.live.handle("s", { type: "query", sid, name: "ms.watch", args: { model: sid } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(3))
    let open!: () => void
    gates.set("busy", new Promise<void>((r) => (open = r)))
    h.live.handle("s", { type: "query", sid: "busy", name: "ms.watch", args: { model: "busy" } })
    await vi.waitFor(() => expect(inFlight).toBe(1))
    h.change("r1")
    h.change("r2")
    h.change("r3")
    await new Promise((r) => setTimeout(r, 20)) // the three re-runs are waiting for the turn
    h.live.handle("s", { type: "query", sid: "asked", name: "ms.watch", args: { model: "asked" } })
    await new Promise((r) => setTimeout(r, 20))
    open()
    await vi.waitFor(() => expect(h.sent.filter((f) => f.type === "QueryResult")).toHaveLength(8))
    const order = h.sent.slice(4).map((f) => f.sid)
    expect(order[0]).toBe("asked")
  })

  // An unsubscribed slot sends nothing, so a re-subscribe of its sid need not wait for its run.
  it("re-subscribing a sid right after unsubscribing it does not wait for the old run", async () => {
    const h = harness()
    gates.set("old", new Promise<void>(() => {})) // the old run never finishes
    h.live.handle("s", { type: "query", sid: "L", name: "ms.watch", args: { model: "old" } })
    await vi.waitFor(() => expect(inFlight).toBe(1))
    h.live.handle("s", { type: "unsubscribe", sid: "L" })
    h.live.handle("s", { type: "query", sid: "L", rid: 2, name: "ms.watch", args: { model: "new" } })
    await vi.waitFor(() => expect(h.frames("L").filter((f) => f.type === "QueryResult")).toHaveLength(1), { timeout: 1000 })
    expect(h.frames("L").find((f) => f.type === "QueryResult")).toMatchObject({ rid: 2, success: true })
  })

  // A paginated re-run held one turn across every page it read.
  it("a paginated re-run takes a turn per page: a request can run between its pages", async () => {
    const calls: string[] = []
    let holdFirstPage: Promise<void> | undefined
    query("ms.clamped", {
      args: v.object({ paginationOpts: v.any() }),
      handler: async ({ paginationOpts }, ctx) => {
        ctx.watch("clamped")
        calls.push(`page@${paginationOpts?.next ?? 0}`)
        if (!paginationOpts?.next && holdFirstPage) await holdFirstPage
        const from = paginationOpts?.next ? Number(paginationOpts.next) : 0
        const rows = [0, 1, 2, 3, 4, 5].slice(from, from + 2).map((_id) => ({ _id })) // clamps to 2
        const end = from + rows.length
        return { results: rows, hasNext: end < 6, next: end < 6 ? String(end) : undefined, hasPrevious: from > 0 }
      },
    })
    query("ms.quick", { args: v.object({}), handler: async () => void calls.push("quick") })
    const h = harness({ maxConcurrentRunsPerSocket: 1 })
    h.live.handle("s", { type: "paginated-query", sid: "P", name: "ms.clamped", args: { paginationOpts: { limit: 6 } } })
    await vi.waitFor(() => expect(h.frames("P")).toHaveLength(1))
    h.live.handle("s", { type: "paginated-query-load-next", sid: "P" })
    h.live.handle("s", { type: "paginated-query-load-next", sid: "P" })
    await vi.waitFor(() => expect(h.frames("P")).toHaveLength(3))
    calls.length = 0
    let releaseFirst!: () => void
    holdFirstPage = new Promise<void>((r) => (releaseFirst = r))
    h.change("clamped")
    await vi.waitFor(() => expect(calls).toEqual(["page@0"])) // the re-run's first page holds the one turn
    h.live.handle("s", { type: "query", sid: "Q", name: "ms.quick", args: {} })
    await new Promise((r) => setTimeout(r, 10))
    releaseFirst()
    await vi.waitFor(() => expect(h.frames("P")).toHaveLength(4))
    expect(calls).toEqual(["page@0", "quick", "page@2", "page@4"]) // Q ran between the re-run's pages
  })
})

describe("many subscriptions: the default limit", () => {
  it("is 32 subscriptions per socket", async () => {
    const { DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET } = await import("@/server/liveQuery")
    expect(DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET).toBe(32)
    const h = harness()
    for (let i = 0; i < 33; i++) h.live.handle("s", { type: "query", sid: i, name: "ms.watch", args: { model: `m${i}` } })
    await vi.waitFor(() => expect(h.sent).toHaveLength(33))
    expect(h.frames(32)[0]).toMatchObject({ success: false, ended: true })
    expect(h.sent.filter((f) => f.success)).toHaveLength(32)
  })
})

describe("many subscriptions: review round F4", () => {
  it("an unusable limit (NaN, 0, a string) falls back to its default, with a warning — not a hang or no limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const h = harness({ maxConcurrentRunsPerSocket: Number(undefined), maxSubscriptionsPerSocket: NaN, turnTimeoutMs: "x" as any })
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a" } })
    await vi.waitFor(() => expect(h.frames("A")).toHaveLength(1)) // NaN runs: every run waited forever
    for (let i = 0; i < 33; i++) h.live.handle("s", { type: "query", sid: i, name: "ms.watch", args: { model: `n${i}` } })
    await vi.waitFor(() => expect(h.sent.filter((f) => f.success === false && f.ended)).toHaveLength(2)) // the limit is 32 again
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("turnTimeoutMs: Infinity keeps the turn (setTimeout would fire after 1 ms)", async () => {
    const h = harness({ maxConcurrentRunsPerSocket: 1, turnTimeoutMs: Infinity })
    let open!: () => void
    gates.set("slow", new Promise<void>((r) => (open = r)))
    h.live.handle("s", { type: "query", sid: "S", name: "ms.watch", args: { model: "slow" } })
    await vi.waitFor(() => expect(inFlight).toBe(1))
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
    await new Promise((r) => setTimeout(r, 40))
    expect(h.frames("B")).toHaveLength(0) // still waiting: the cap holds
    open()
    await vi.waitFor(() => expect(h.frames("B")).toHaveLength(1))
  })

  // The scheduler key was the sid's: a re-subscribed sid's re-runs folded into the old,
  // unsubscribed subscription's run still in flight, and waited for it (forever, if it hung).
  it("a re-subscribed sid's re-runs do not wait for the unsubscribed one's run", async () => {
    const h = harness()
    h.live.handle("s", { type: "query", sid: "x", name: "ms.watch", args: { model: "old" } })
    await vi.waitFor(() => expect(h.frames("x")).toHaveLength(1))
    gates.set("old", new Promise<void>(() => {})) // its next run hangs
    h.change("old")
    await vi.waitFor(() => expect(inFlight).toBe(1))
    h.live.handle("s", { type: "unsubscribe", sid: "x" })
    h.live.handle("s", { type: "query", sid: "x", rid: 2, name: "ms.watch", args: { model: "fresh" } })
    await vi.waitFor(() => expect(h.frames("x").filter((f) => f.type === "QueryResult")).toHaveLength(2))
    h.change("fresh")
    await vi.waitFor(() => expect(h.frames("x").filter((f) => f.type === "QueryResult")).toHaveLength(3), { timeout: 1000 })
  })

  // Turns given up on timeout were handed over while the old runs went on: with hung handlers a
  // socket added maxConcurrentRunsPerSocket runs every turnTimeoutMs, without bound.
  it("at most maxConcurrentRunsPerSocket runs may be over time at once: then a turn is kept", async () => {
    const h = harness({ maxConcurrentRunsPerSocket: 1, turnTimeoutMs: 20 })
    for (const sid of ["h1", "h2", "h3"]) gates.set(sid, new Promise<void>(() => {}))
    for (const sid of ["h1", "h2", "h3"]) h.live.handle("s", { type: "query", sid, name: "ms.watch", args: { model: sid } })
    await new Promise((r) => setTimeout(r, 200))
    expect(maxInFlight).toBe(2) // h1 over time, h2 holding the turn; h3 waits
  })

  it("a paginated re-run stops reading pages once its subscription is replaced", async () => {
    const calls: string[] = []
    let holdFirst: Promise<void> | undefined
    query("ms.clamped2", {
      args: v.object({ paginationOpts: v.any(), tag: v.string() }),
      handler: async ({ paginationOpts, tag }, ctx) => {
        ctx.watch("clamped2")
        calls.push(`${tag}@${paginationOpts?.next ?? 0}`)
        if (tag === "old" && !paginationOpts?.next && holdFirst) await holdFirst
        const from = paginationOpts?.next ? Number(paginationOpts.next) : 0
        const rows = [0, 1, 2, 3, 4, 5].slice(from, from + 2).map((_id) => ({ _id }))
        const end = from + rows.length
        return { results: rows, hasNext: end < 6, next: end < 6 ? String(end) : undefined, hasPrevious: from > 0 }
      },
    })
    const h = harness()
    h.live.handle("s", { type: "paginated-query", sid: "P", name: "ms.clamped2", args: { tag: "old", paginationOpts: { limit: 6 } } })
    await vi.waitFor(() => expect(h.frames("P")).toHaveLength(1))
    h.live.handle("s", { type: "paginated-query-load-next", sid: "P" })
    h.live.handle("s", { type: "paginated-query-load-next", sid: "P" })
    await vi.waitFor(() => expect(h.frames("P")).toHaveLength(3))
    let release!: () => void
    holdFirst = new Promise<void>((r) => (release = r))
    calls.length = 0
    h.change("clamped2")
    await vi.waitFor(() => expect(calls).toEqual(["old@0"]))
    h.live.handle("s", { type: "paginated-query", sid: "P", name: "ms.clamped2", args: { tag: "new", paginationOpts: { limit: 2 } } })
    release()
    await vi.waitFor(() => expect(calls).toContain("new@0"))
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.filter((c) => c.startsWith("old"))).toEqual(["old@0"]) // no more pages for the replaced one
  })
})

describe("many subscriptions: review round F5", () => {
  // A removed slot's run (its watch opens, up to 10 s each on a cold stream) went on outside the
  // count: a subscribe/unsubscribe loop on fresh sids held any number of opens at once.
  it("a removed subscription whose work is still running counts toward the limit until it settles", async () => {
    let finishOpen!: () => void
    const opening = new Promise<void>((r) => (finishOpen = r))
    const h = harness({
      maxSubscriptionsPerSocket: 2,
      openWatch: async (spec) => {
        if (spec.model === "slowopen") await opening
        return { close: async () => {} }
      },
    })
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "slowopen" } })
    await vi.waitFor(() => expect(inFlight).toBe(0)) // its handler ran; its watch is opening
    await new Promise((r) => setTimeout(r, 10))
    h.live.handle("s", { type: "unsubscribe", sid: "A" })
    h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
    h.live.handle("s", { type: "query", sid: "C", name: "ms.watch", args: { model: "c" } })
    await vi.waitFor(() => expect(h.frames("C")).toHaveLength(1))
    expect(h.frames("C")[0]).toMatchObject({ success: false, ended: true }) // A's open still counts
    finishOpen()
    await new Promise((r) => setTimeout(r, 20))
    h.live.handle("s", { type: "query", sid: "D", name: "ms.watch", args: { model: "d" } })
    await vi.waitFor(() => expect(h.frames("D")).toHaveLength(1))
    expect(h.frames("D")[0].success).toBe(true)
  })

  it("maxRerunRows: NaN is its default (1000), not a re-read of the whole collection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const h = harness({ maxRerunRows: NaN, debounceMs: NaN, maxWaitMs: NaN })
    h.live.handle("s", { type: "paginated-query", sid: "P", name: "ms.page", args: { model: "p", paginationOpts: { limit: 2 } } })
    await vi.waitFor(() => expect(h.frames("P")).toHaveLength(1))
    h.change("p")
    await vi.waitFor(() => expect(h.frames("P")).toHaveLength(2))
    expect(h.frames("P")[1].data.results).toHaveLength(2) // the loaded window, not all 6 rows
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/maxRerunRows/)
    warn.mockRestore()
  })

  // runQuery checked whether its subscription was still current only after the handler ran.
  it("a change-triggered re-run of a subscription replaced while it waited for a turn does not run", async () => {
    const h = harness({ maxConcurrentRunsPerSocket: 1 })
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a1" } })
    await vi.waitFor(() => expect(h.frames("A")).toHaveLength(1))
    let open!: () => void
    gates.set("busy", new Promise<void>((r) => (open = r)))
    h.live.handle("s", { type: "query", sid: "busy", name: "ms.watch", args: { model: "busy" } })
    await vi.waitFor(() => expect(inFlight).toBe(1))
    h.change("a1") // A's re-run waits for the turn
    await new Promise((r) => setTimeout(r, 20))
    h.live.handle("s", { type: "query", sid: "A", name: "ms.watch", args: { model: "a2" } })
    const ran: string[] = []
    const spy = vi.spyOn(handlers, "_runQuery").mockImplementation(async (_n: string, args: any) => {
      ran.push(args?.model)
      return null
    })
    open()
    await vi.waitFor(() => expect(h.frames("A")).toHaveLength(2))
    expect(ran).toEqual(["a2"]) // the replaced a1 re-run never ran
    spy.mockRestore()
  })

  // Runs waiting for a turn kept their closure (and the socket) alive after the socket closed,
  // as long as the runs holding the turns did not settle.
  it("closing a socket drops the runs waiting for a turn", async () => {
    const h = harness({ maxConcurrentRunsPerSocket: 1, turnTimeoutMs: Infinity })
    gates.set("hung", new Promise<void>(() => {}))
    h.live.handle("s", { type: "query", sid: "H", name: "ms.watch", args: { model: "hung" } })
    await vi.waitFor(() => expect(inFlight).toBe(1))
    h.live.handle("s", { type: "query", sid: "W", name: "ms.watch", args: { model: "w" } })
    const sock = (h.live as any)._socket("s")
    await vi.waitFor(() => expect(sock.waitingAsked.length + sock.waiting.length).toBe(1))
    await h.live.close("s")
    expect(sock.waitingAsked.length + sock.waiting.length).toBe(0)
  })
})

describe("many subscriptions: review round F6", () => {
  // F5 dropped the waiters on close; their chains never settled, so a re-run waiting for a turn
  // left its scheduler entry in flight forever — one leaked entry per such closed socket.
  it("closing a socket settles the runs waiting for a turn (nothing stays in flight)", async () => {
    const h = harness({ maxConcurrentRunsPerSocket: 1, turnTimeoutMs: Infinity })
    h.live.handle("s", { type: "query", sid: "W", name: "ms.watch", args: { model: "w" } })
    await vi.waitFor(() => expect(h.frames("W")).toHaveLength(1))
    gates.set("hung", new Promise<void>(() => {}))
    h.live.handle("s", { type: "query", sid: "H", name: "ms.watch", args: { model: "hung" } })
    await vi.waitFor(() => expect(inFlight).toBe(1))
    h.change("w") // W's re-run waits for the turn
    const sock = (h.live as any)._socket("s")
    await vi.waitFor(() => expect(sock.waiting.length).toBe(1))
    const queue = [...sock.slots.values()].find((slot: any) => slot.sid === "W").queue
    await h.live.close("s")
    let settled = false
    void queue.then(() => (settled = true))
    await vi.waitFor(() => expect(settled).toBe(true)) // the waiting re-run's chain settles
  })

  // F5 counted a removed slot until its queue settled; one whose handler hung counted forever,
  // and 32 of them left the socket refusing every new subscription with no slot in use.
  it("a removed subscription stops counting toward the limit after a bounded time, even if its run hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const h = harness({ maxSubscriptionsPerSocket: 1, turnTimeoutMs: 50 })
      gates.set("hung", new Promise<void>(() => {}))
      h.live.handle("s", { type: "query", sid: "H", name: "ms.watch", args: { model: "hung" } })
      await vi.advanceTimersByTimeAsync(5)
      h.live.handle("s", { type: "unsubscribe", sid: "H" })
      h.live.handle("s", { type: "query", sid: "B", name: "ms.watch", args: { model: "b" } })
      await vi.advanceTimersByTimeAsync(5)
      expect(h.frames("B")[0]).toMatchObject({ success: false, ended: true }) // H's run still counts
      await vi.advanceTimersByTimeAsync(20_000)
      h.live.handle("s", { type: "query", sid: "C", name: "ms.watch", args: { model: "c" } })
      await vi.advanceTimersByTimeAsync(5)
      expect(h.frames("C")[0]).toMatchObject({ success: true })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("many subscriptions: review round F7", () => {
  // A new subscription on the same slot (the same sid, or the default one) queued behind the
  // replaced subscription's run, without bound: a hung handler left the new one never answered.
  // On main every subscription got a fresh queue.
  for (const sid of ["s1", undefined]) {
    it(`replacing ${sid ? "a sid's" : "the default"} subscription waits for its hung run at most turnTimeoutMs`, async () => {
      const h = harness({ turnTimeoutMs: 40 })
      h.live.handle("s", { type: "query", sid, name: "ms.watch", args: { model: "old" } })
      await vi.waitFor(() => expect(h.frames(sid)).toHaveLength(1))
      gates.set("old", new Promise<void>(() => {})) // its next run hangs
      h.change("old")
      await vi.waitFor(() => expect(inFlight).toBe(1))
      h.live.handle("s", { type: "query", sid, rid: 2, name: "ms.watch", args: { model: "new" } })
      await vi.waitFor(() => expect(h.frames(sid).at(-1)).toMatchObject({ rid: 2, success: true }), { timeout: 1000 })
    })
  }
})

describe("many subscriptions: review round F8", () => {
  // After the bounded wait the replacement answers first; the replaced subscription's slow run
  // then answered too, with the same sid and type — a client without rids showed page 1's rows
  // under page 2's arguments. An answer overtaken by a newer subscription's is dropped.
  for (const sid of ["s1", undefined]) {
    it(`a replaced subscription's answer that comes after its replacement's is dropped (${sid ? "sid" : "default"})`, async () => {
      const h = harness({ turnTimeoutMs: 30 })
      let finishOld!: () => void
      gates.set("old", new Promise<void>((r) => (finishOld = r)))
      h.live.handle("s", { type: "query", sid, name: "ms.watch", args: { model: "old" } })
      await vi.waitFor(() => expect(inFlight).toBe(1))
      h.live.handle("s", { type: "query", sid, name: "ms.watch", args: { model: "new" } })
      await vi.waitFor(() => expect(h.frames(sid)).toHaveLength(1))
      expect(h.frames(sid)[0].data.model).toBe("new")
      finishOld()
      await new Promise((r) => setTimeout(r, 30))
      expect(h.frames(sid).map((f) => f.data?.model)).toEqual(["new"]) // the old answer, overtaken, is not sent
    })
  }

  it("an old answer that comes BEFORE its replacement's is still sent", async () => {
    const h = harness({ turnTimeoutMs: 5000 })
    h.live.handle("s", { type: "query", sid: "k", name: "ms.watch", args: { model: "first" } })
    h.live.handle("s", { type: "query", sid: "k", name: "ms.watch", args: { model: "second" } })
    await vi.waitFor(() => expect(h.frames("k")).toHaveLength(2))
    expect(h.frames("k").map((f) => f.data.model)).toEqual(["first", "second"])
  })
})

describe("many subscriptions: review round F9", () => {
  it("a replacement live-updates even while the replaced subscription's re-run hangs", async () => {
    const h = harness({ turnTimeoutMs: 30 })
    h.live.handle("s", { type: "query", sid: "a", name: "ms.watch", args: { model: "old" } })
    await vi.waitFor(() => expect(h.frames("a")).toHaveLength(1))
    gates.set("old", new Promise<void>(() => {}))
    h.change("old") // its re-run hangs
    await vi.waitFor(() => expect(inFlight).toBe(1))
    h.live.handle("s", { type: "query", sid: "a", name: "ms.watch", args: { model: "fresh" } })
    await vi.waitFor(() => expect(h.frames("a").at(-1)?.data?.model).toBe("fresh"), { timeout: 1000 })
    const before = h.frames("a").length
    h.change("fresh")
    await vi.waitFor(() => expect(h.frames("a").length).toBe(before + 1), { timeout: 1000 }) // its re-run was stuck behind the old one's
  })

  // The answeredGen rule dropped a queued load's refusal once a newer subscription had answered,
  // though a load the client asked for must be answered or its loading state never settles.
  it("a load queued for a replaced subscription is still refused, even after the replacement answered", async () => {
    const h = harness({ turnTimeoutMs: 30 })
    let releaseOld!: () => void
    gates.set("pold", new Promise<void>((r) => (releaseOld = r)))
    query("ms.pageGate", {
      args: v.object({ model: v.string(), paginationOpts: v.any() }),
      handler: async ({ model }, ctx) => {
        ctx.watch(model)
        await gates.get(model)
        return { results: [{ _id: 1 }], hasNext: true, next: "1", hasPrevious: false }
      },
    })
    h.live.handle("s", { type: "paginated-query", sid: "P", name: "ms.pageGate", args: { model: "pold" } })
    h.live.handle("s", { type: "paginated-query-load-next", sid: "P", rid: "load" })
    h.live.handle("s", { type: "paginated-query", sid: "P", name: "ms.pageGate", args: { model: "pnew" } })
    await vi.waitFor(() => expect(h.frames("P").some((f) => f.type === "PaginatedQueryResult" && f.success)).toBe(true), { timeout: 1000 })
    releaseOld()
    await vi.waitFor(() => expect(h.frames("P").some((f) => f.type === "PaginatedQueryPage" && f.rid === "load")).toBe(true), { timeout: 1000 })
  })
})

describe("many subscriptions: review round F10", () => {
  // A load queued behind a re-run that failed (and sent `ended: true`) was then refused with the
  // sid — after the client had re-subscribed it, so the refusal looked like the new
  // subscription's. The ended frame already ended its pending loads.
  it("a load still queued when its sid's subscription ended (ended: true) is not answered", async () => {
    let failNow!: () => void
    query("ms.pageFail", {
      args: v.object({ paginationOpts: v.any() }),
      handler: async (_a, ctx) => {
        ctx.watch("pf")
        if (failNow === undefined) return { results: [{ _id: 1 }], hasNext: true, next: "1", hasPrevious: false }
        await new Promise<void>((r) => (failNow = r))
        throw new Error("revoked")
      },
    })
    const h = harness()
    h.live.handle("s", { type: "paginated-query", sid: "a", name: "ms.pageFail", args: {} })
    await vi.waitFor(() => expect(h.frames("a")).toHaveLength(1))
    failNow = undefined as any
    ;(failNow as any) = null // the next run waits, then fails
    h.change("pf")
    await vi.waitFor(() => expect(typeof failNow).toBe("function"))
    h.live.handle("s", { type: "paginated-query-load-next", sid: "a", rid: "L" }) // queued behind the failing re-run
    failNow()
    await vi.waitFor(() => expect(h.frames("a").some((f) => f.ended)).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.frames("a").filter((f) => f.type === "PaginatedQueryPage")).toEqual([]) // no stray refusal
  })
})

describe("many subscriptions: review round F15", () => {
  // A change-triggered re-run queued on a slot's old queue (behind a slow load) ran whatever
  // subscription was current when it started. Once a replacement stopped waiting for that queue
  // (turnTimeoutMs) and went live, the stale re-run ran the NEW subscription beside its own runs:
  // two runs of one subscription at once, both reconciling its watches — and the watch opened
  // twice, overwritten in the slot, was never closed.
  it("a re-run queued before a replacement never runs the replacement beside its own runs", async () => {
    let releaseLoad!: () => void
    query("f15.slowpage", {
      args: v.object({ model: v.string(), paginationOpts: v.any() }),
      handler: async ({ model, paginationOpts }, ctx) => {
        ctx.watch(model)
        if (paginationOpts?.next) await new Promise<void>((r) => (releaseLoad = r))
        return { results: [{ _id: 1 }], hasNext: true, next: "1", hasPrevious: false }
      },
    })
    const h = harness({ turnTimeoutMs: 30 })
    h.live.handle("s", { type: "paginated-query", sid: "x", name: "f15.slowpage", args: { model: "pa", paginationOpts: { limit: 1 } } })
    await vi.waitFor(() => expect(h.frames("x")).toHaveLength(1))
    h.live.handle("s", { type: "paginated-query-load-next", sid: "x" }) // held
    await vi.waitFor(() => expect(releaseLoad).toBeTypeOf("function"))
    h.change("pa") // a re-run, queued behind the held load
    await new Promise((r) => setTimeout(r, 5))
    h.live.handle("s", { type: "query", sid: "x", name: "ms.watch", args: { model: "pb" } })
    await vi.waitFor(() => expect(h.frames("x").some((f) => f.type === "QueryResult")).toBe(true)) // live after the 30 ms wait
    let releaseB!: () => void
    gates.set("pb", new Promise<void>((r) => (releaseB = r)))
    h.change("pb") // the replacement's own re-run, held
    await vi.waitFor(() => expect(inFlight).toBe(1))
    releaseLoad() // the old queue resumes: its re-run must not run the replacement now
    await new Promise((r) => setTimeout(r, 20))
    expect(maxInFlight).toBe(1)
    releaseB()
    await vi.waitFor(() => expect(inFlight).toBe(0))
    await h.live.close("s")
  })
})

describe("paginated-query without paginationOpts", () => {
  // Re-runs and loads always hand a paginated handler a paginationOpts object, the first run
  // handed it the client's args as sent. A client that sent none was refused by a handler
  // declaring paginationOpts (zod 4.4+ requires a `v.any()` key too) on its first run only.
  it("the first run gets paginationOpts {}, as re-runs and loads do", async () => {
    const seen: unknown[] = []
    query("nopo.page", {
      args: v.object({ model: v.string(), paginationOpts: v.object({ limit: v.number().optional() }) }),
      handler: async ({ model, paginationOpts }, ctx) => {
        ctx.watch(model)
        seen.push(paginationOpts)
        return { results: [{ _id: 1 }], hasNext: false, hasPrevious: false }
      },
    })
    const h = harness()
    h.live.handle("s", { type: "paginated-query", sid: "n", name: "nopo.page", args: { model: "nopo" } })
    await vi.waitFor(() => expect(h.frames("n")).toHaveLength(1))
    expect(h.frames("n")[0]).toMatchObject({ type: "PaginatedQueryResult", success: true })
    expect(seen[0]).toEqual({})
    await h.live.close("s")
  })
})
