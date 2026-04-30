import { describe, it, expect, vi } from "vitest"
import { createStreamHub } from "@/server/streamHub"
import { makeFakeStreamFactory } from "../../helpers/fakeChangeStream"

function setup() {
  const { factory, opened } = makeFakeStreamFactory()
  const hub = createStreamHub({ openStream: (model) => Promise.resolve(factory(model)) })
  return { hub, factory, opened }
}

describe("streamHub: refcount lifecycle", () => {
  it("opens one stream on first subscribe", async () => {
    const { hub, opened } = setup()
    const cb = vi.fn()
    const unsub = await hub.subscribe("orders", undefined, cb)
    expect(opened.orders).toHaveLength(1)
    await unsub()
  })

  it("does not open a second stream for additional subscribers on the same model", async () => {
    const { hub, opened } = setup()
    const u1 = await hub.subscribe("orders", undefined, vi.fn())
    const u2 = await hub.subscribe("orders", { "fullDocument.userId": "a" }, vi.fn())
    expect(opened.orders).toHaveLength(1)
    await u1()
    await u2()
  })

  it("closes the underlying stream after the last unsubscribe", async () => {
    const { hub, opened } = setup()
    const u1 = await hub.subscribe("orders", undefined, vi.fn())
    const u2 = await hub.subscribe("orders", undefined, vi.fn())
    await u1()
    expect(opened.orders[0].closed).toBe(false)
    await u2()
    expect(opened.orders[0].closed).toBe(true)
  })

  it("re-opens a stream after all subscribers leave then a new one joins", async () => {
    const { hub, opened } = setup()
    const u1 = await hub.subscribe("orders", undefined, vi.fn())
    await u1()
    expect(opened.orders[0].closed).toBe(true)
    await hub.subscribe("orders", undefined, vi.fn())
    expect(opened.orders).toHaveLength(2)
  })
})

describe("streamHub: fanout + filter evaluation", () => {
  it("notifies all matching subscribers on a change event", async () => {
    const { hub, opened } = setup()
    const a = vi.fn()
    const b = vi.fn()
    const c = vi.fn()
    await hub.subscribe("orders", { "fullDocument.userId": "x" }, a)
    await hub.subscribe("orders", { "fullDocument.userId": "y" }, b)
    await hub.subscribe("orders", undefined, c)
    opened.orders[0].emitChange({ _id: "1", userId: "x" })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(c).toHaveBeenCalledTimes(1)
  })

  it("does not notify on a no-match change", async () => {
    const { hub, opened } = setup()
    const cb = vi.fn()
    await hub.subscribe("orders", { "fullDocument.userId": "x" }, cb)
    opened.orders[0].emitChange({ _id: "1", userId: "y" })
    expect(cb).not.toHaveBeenCalled()
  })

  it("filters delete events when filter only references fullDocument", async () => {
    // Strict semantics: delete events carry no fullDocument, so a
    // fullDocument.X-only filter doesn't match. Subscribers that want delete
    // notifications must OR with operationType:"delete" (the bare-filter
    // shorthand in attachWs/watchInput does this automatically).
    const { hub, opened } = setup()
    const cb = vi.fn()
    await hub.subscribe("orders", { "fullDocument.userId": "x" }, cb)
    opened.orders[0].emitChange({ _id: "1" }, "delete")
    expect(cb).not.toHaveBeenCalled()
  })

  it("notifies on delete when filter explicitly OR's operationType", async () => {
    const { hub, opened } = setup()
    const cb = vi.fn()
    await hub.subscribe(
      "orders",
      { $or: [{ "fullDocument.userId": "x" }, { operationType: "delete" }] },
      cb
    )
    opened.orders[0].emitChange({ _id: "1" }, "delete")
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it("matches on top-level operationType", async () => {
    const { hub, opened } = setup()
    const cb = vi.fn()
    await hub.subscribe("orders", { operationType: "insert" }, cb)
    opened.orders[0].emitChange({ _id: "1", userId: "x" }, "insert")
    opened.orders[0].emitChange({ _id: "2", userId: "x" }, "update")
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe("streamHub: error handling", () => {
  it("rejects subscribe with unsupported filter operator", async () => {
    const { hub } = setup()
    await expect(
      hub.subscribe("orders", { $expr: { $eq: ["$a", "$b"] } } as any, vi.fn())
    ).rejects.toThrow(/unsupported filter/i)
  })

  it("on stream error, retries once after a delay", async () => {
    vi.useFakeTimers()
    const { factory, opened } = makeFakeStreamFactory()
    const hub = createStreamHub({
      openStream: (model) => Promise.resolve(factory(model)),
      reconnectDelayMs: 1000,
    })
    const cb = vi.fn()
    await hub.subscribe("orders", undefined, cb)
    opened.orders[0].emitError(new Error("boom"))
    await vi.advanceTimersByTimeAsync(1100)
    expect(opened.orders.length).toBe(2)
    vi.useRealTimers()
  })
})
