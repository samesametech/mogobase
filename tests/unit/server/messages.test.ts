// The WebSocket protocol's routing, shared by both transports (review round 11).
import { describe, expect, it, vi } from "vitest"
import { handleMessage, type MessageTransport } from "@/server/messages"

function transport() {
  const sent: any[] = []
  const handled: any[] = []
  const t: MessageTransport = {
    id: "s",
    headers: {},
    send: (p) => void sent.push(p),
    live: { handle: (_id: string, msg: any) => (handled.push(msg), true) } as any,
    syncState: () => ({}),
    syncPolicy: undefined,
    syncHub: {} as any,
    formatError: (e: any) => e.message,
    label: "test",
  }
  return { t, sent, handled }
}

describe("handleMessage", () => {
  it("routes live-query messages to the engine", async () => {
    const { t, handled } = transport()
    for (const type of ["query", "paginated-query"]) await handleMessage(JSON.stringify({ type, name: "q" }), t)
    for (const type of ["paginated-query-load-next", "paginated-query-load-previous"]) await handleMessage(JSON.stringify({ type }), t)
    expect(handled.map((m) => m.type)).toEqual(["query", "paginated-query", "paginated-query-load-next", "paginated-query-load-previous"])
  })

  it("answers what is not a live query: bad JSON, no name, a mutation, an unknown type — rid echoed", async () => {
    const { t, sent } = transport()
    await handleMessage("{oops", t)
    await handleMessage("null", t)
    await handleMessage(JSON.stringify({ type: "query", rid: "a" }), t)
    await handleMessage(JSON.stringify({ type: "mutation", name: "m", rid: "b" }), t)
    await handleMessage(JSON.stringify({ type: "qeury", name: "q", rid: "c" }), t)
    expect(sent.map((f) => f.error ?? f.type)).toEqual([
      "Invalid JSON",
      "Invalid message",
      "Name is required",
      expect.stringMatching(/Mutations are not accepted/),
      "Unknown type: qeury",
    ])
    expect(sent.slice(2).map((f) => f.rid)).toEqual(["a", "b", "c"])
  })
})

describe("handleMessage: many subscriptions on one socket (4.0.0)", () => {
  it("routes unsubscribe to the engine (it has no name)", async () => {
    const { t, handled, sent } = transport()
    await handleMessage(JSON.stringify({ type: "unsubscribe", sid: "A" }), t)
    expect(handled.map((m) => m.type)).toEqual(["unsubscribe"])
    expect(sent).toEqual([])
  })

  it("a refusal before the engine echoes the sid as well as the rid", async () => {
    const { t, sent } = transport()
    await handleMessage(JSON.stringify({ type: "query", sid: "A", rid: 1 }), t)
    await handleMessage(JSON.stringify({ type: "qeury", name: "q", sid: 7 }), t)
    expect(sent[0]).toMatchObject({ error: "Name is required", sid: "A", rid: 1 })
    expect(sent[1]).toMatchObject({ sid: 7 })
  })
})

describe("handleMessage: review round F6", () => {
  it("a query with a sid and no name is refused on the frame type its request would get", async () => {
    const { t, sent } = transport()
    await handleMessage(JSON.stringify({ type: "paginated-query", sid: "x", rid: 5 }), t)
    await handleMessage(JSON.stringify({ type: "query", rid: 6 }), t) // no sid: as before 4.0.0
    expect(sent[0]).toMatchObject({ type: "PaginatedQueryResult", success: false, error: "Name is required", sid: "x", rid: 5 })
    expect(sent[1]).toEqual({ success: false, error: "Name is required", rid: 6 })
  })
})

describe("handleMessage: review round F13", () => {
  // The name check ran before the mutation and unknown-type branches: a mutation sent without a
  // name got "Name is required", not the refusal naming the fix (POST /api/handlers), and a
  // mistyped type without a name was told to add a name.
  it("a mutation or an unknown type without a name gets its own answer, not \"Name is required\"", async () => {
    const { t, sent } = transport()
    await handleMessage(JSON.stringify({ type: "mutation", args: {}, rid: 1 }), t)
    await handleMessage(JSON.stringify({ type: "qeury", rid: 2 }), t)
    expect(sent[0]).toMatchObject({ type: "MutationResult", success: false, error: expect.stringMatching(/Mutations are not accepted/), rid: 1 })
    expect(sent[1]).toMatchObject({ error: "Unknown type: qeury", rid: 2 })
  })
})
