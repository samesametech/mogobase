// The legacy ws.ts transport takes the many-subscriptions limits too (round F2): every watch there
// is a change stream of its own, and nothing in its API could lower the default 100 per socket.
import { describe, expect, it, vi } from "vitest"
import ws from "@/server/ws"
import { query, v } from "@/server/handlers"

describe("ws.setLiveQueryOptions", () => {
  it("caps the subscriptions one legacy socket may hold", async () => {
    query("wsOpts.q", { args: v.object({}), handler: async () => 1 })
    ;(ws as any)._liveEngine = undefined // a fresh engine, as at server start
    ws.setLiveQueryOptions({ maxSubscriptionsPerSocket: 1 })
    const sent: any[] = []
    const live = (ws as any)._live
    live.open("legacy-socket", { headers: {}, isOpen: () => true, send: (p: any) => void sent.push(p) })
    live.handle("legacy-socket", { type: "query", sid: "a", name: "wsOpts.q", args: {} })
    live.handle("legacy-socket", { type: "query", sid: "b", name: "wsOpts.q", args: {} })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent.find((f) => f.sid === "b")).toMatchObject({ success: false, ended: true })
    await live.close("legacy-socket")
  })
})

describe("ws.setLiveQueryOptions: review round F3", () => {
  it("passes on only its documented fields", () => {
    ;(ws as any)._liveEngine = undefined
    ;(ws as any)._liveOptions = undefined
    ws.setLiveQueryOptions({ maxSubscriptionsPerSocket: 5, maxWaitMs: 0 } as any)
    expect((ws as any)._liveOptions).toEqual({ maxSubscriptionsPerSocket: 5 })
  })
})

describe("ws.setLiveQueryOptions: review round F4", () => {
  it("a second call adds to the first instead of resetting what it leaves out", () => {
    ;(ws as any)._liveEngine = undefined
    ;(ws as any)._liveOptions = undefined
    ws.setLiveQueryOptions({ maxSubscriptionsPerSocket: 8 })
    ws.setLiveQueryOptions({ turnTimeoutMs: 20_000 })
    expect((ws as any)._liveOptions).toMatchObject({ maxSubscriptionsPerSocket: 8, turnTimeoutMs: 20_000 })
  })
})

describe("ws.setLiveQueryOptions: review round F13", () => {
  // Only three keys were copied: maxRerunRows, refetchMaxWaitMs and maxBufferedBytes, which
  // attachMogobaseWebSocket takes, were dropped without a word, and backpressure was fixed at 1 MiB.
  // Round F19: refetchMaxWaitMs bounds how long a debounce may hold a burst — and this transport
  // re-runs at once (no debounce), so it can hold nothing: taken, it did nothing. Refused, said so.
  it("takes the re-run cap and the backpressure threshold too, and says what it ignores", () => {
    ;(ws as any)._liveEngine = undefined
    ;(ws as any)._liveOptions = undefined
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    ws.setLiveQueryOptions({ maxRerunRows: 50, refetchMaxWaitMs: 200, maxBufferedBytes: 4096, debounceMs: 5 } as any)
    expect((ws as any)._liveOptions).toEqual({ maxRerunRows: 50, maxBufferedBytes: 4096 })
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/refetchMaxWaitMs ignored/),
      expect.stringMatching(/debounceMs ignored/),
    ])
    void (ws as any)._live // the engine is built with them
    expect((ws as any)._maxBufferedBytes).toBe(4096)
    warn.mockRestore()
    ;(ws as any)._liveEngine = undefined
    ;(ws as any)._liveOptions = undefined
  })
})
