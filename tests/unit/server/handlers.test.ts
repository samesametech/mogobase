// tests/unit/server/handlers.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import handlers, {
  query,
  mutation,
  internalQuery,
  internalMutation,
  runQuery,
  runMutation,
  runInternalQuery,
  runInternalMutation,
  v,
} from "@/server/handlers"

function resetHandlers() {
  handlers.queries.clear()
  handlers.mutations.clear()
  handlers._queries.clear()
  handlers._mutations.clear()
}

const fakeDb: any = {
  model: () => ({
    insertOne: () => ({ acknowledged: true }),
    findOne: () => null,
  }),
}

describe("handler registration", () => {
  beforeEach(() => resetHandlers())

  it("registers a query and runs it", async () => {
    query("getThing", {
      args: v.object({ id: v.string() }),
      handler: async (args) => ({ id: args.id, name: "thing" }),
    })
    const res = await runQuery("getThing", { id: "x" }, { db: fakeDb })
    expect(res).toEqual({ id: "x", name: "thing" })
  })

  it("registers a mutation and runs it", async () => {
    mutation("createThing", {
      args: v.object({ name: v.string() }),
      handler: async (args) => ({ ok: true, name: args.name }),
    })
    const res = await runMutation("createThing", { name: "x" }, { db: fakeDb })
    expect(res).toEqual({ ok: true, name: "x" })
  })

  it("throws on duplicate query name", () => {
    query("dup", { args: v.object({}), handler: async () => 1 })
    expect(() => query("dup", { args: v.object({}), handler: async () => 2 })).toThrow(/already exists/)
  })

  it("throws on duplicate mutation name", () => {
    mutation("dup", { args: v.object({}), handler: async () => 1 })
    expect(() => mutation("dup", { args: v.object({}), handler: async () => 2 })).toThrow(/already exists/)
  })
})

describe("arg validation", () => {
  beforeEach(() => resetHandlers())

  it("rejects invalid args with descriptive error", async () => {
    query("strict", {
      args: v.object({ id: v.string() }),
      handler: async () => 1,
    })
    await expect(runQuery("strict", { id: 123 }, { db: fakeDb })).rejects.toThrow(/Invalid args/)
  })

  it("accepts empty args object when schema is empty", async () => {
    query("nullable", { args: v.object({}), handler: async () => 7 })
    const res = await runQuery("nullable", {}, { db: fakeDb })
    expect(res).toBe(7)
  })
})

describe("internal handlers and prefix routing", () => {
  beforeEach(() => resetHandlers())

  it("registers internal queries with internal. prefix, reachable via runInternalQuery", async () => {
    internalQuery("secret", { args: v.object({}), handler: async () => "ok" })
    expect(handlers._queries.has("internal.secret")).toBe(true)
    const res = await runInternalQuery("internal.secret", {}, { db: fakeDb })
    expect(res).toBe("ok")
  })

  it("internal mutations are stored separately from public ones", async () => {
    mutation("doThing", { args: v.object({}), handler: async () => "public" })
    internalMutation("doThing", { args: v.object({}), handler: async () => "private" })
    const pub = await runMutation("doThing", {}, { db: fakeDb })
    const priv = await runInternalMutation("internal.doThing", {}, { db: fakeDb })
    expect(pub).toBe("public")
    expect(priv).toBe("private")
  })

  it("rejects unknown handler with informative error", async () => {
    await expect(runQuery("nope", {}, { db: fakeDb })).rejects.toThrow(/not found/)
  })

  // Security boundary: the public runQuery/runMutation exports are the
  // network-facing entry points (HTTP /api/handlers, /ws, hono). They MUST NOT
  // resolve the in-process-only internal pool, even when the caller names an
  // internal handler directly — otherwise any authenticated client could invoke
  // privileged in-process handlers (payment/refund/gateway mutations) over HTTP.
  it("public runQuery does NOT resolve internal handlers", async () => {
    internalQuery("secret", { args: v.object({}), handler: async () => "ok" })
    await expect(runQuery("internal.secret", {}, { db: fakeDb })).rejects.toThrow(/not found/)
  })

  it("public runMutation does NOT resolve internal handlers", async () => {
    internalMutation("doThing", { args: v.object({}), handler: async () => "private" })
    await expect(runMutation("internal.doThing", {}, { db: fakeDb })).rejects.toThrow(/not found/)
  })
})

describe("cross-handler invocation via ctx.runQuery / ctx.runMutation", () => {
  beforeEach(() => resetHandlers())

  it("a query can call another query via ctx.runQuery", async () => {
    query("inner", {
      args: v.object({ n: v.number() }),
      handler: async (args) => args.n * 2,
    })
    query("outer", {
      args: v.object({ n: v.number() }),
      handler: async (args, ctx) => {
        const doubled = await ctx.runQuery("inner", { n: args.n })
        return doubled + 1
      },
    })
    const res = await runQuery("outer", { n: 5 }, { db: fakeDb })
    expect(res).toBe(11)
  })

  it("a mutation can call internal mutation by name", async () => {
    internalMutation("stamp", {
      args: v.object({ id: v.string() }),
      handler: async (args) => ({ stamped: args.id }),
    })
    mutation("public", {
      args: v.object({ id: v.string() }),
      handler: async (args, ctx) => ctx.runMutation("internal.stamp", args),
    })
    const res = await runMutation("public", { id: "x" }, { db: fakeDb })
    expect(res).toEqual({ stamped: "x" })
  })
})

describe("ctx.db requirement", () => {
  beforeEach(() => resetHandlers())

  it("throws when ctx.db is missing", async () => {
    query("needsDb", { args: v.object({}), handler: async (_a, ctx) => ctx.db })
    await expect(runQuery("needsDb", {}, {} as any)).rejects.toThrow(/ctx\.db/)
  })
})
