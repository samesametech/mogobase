// tests/unit/server/handlers.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest"
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

  // A refusal used to keep only issues[0].message, so a client learned what was
  // wrong but never which field ("Invalid args: Invalid input: expected string,
  // received undefined"), and an app could not tell a missing field from a bad one.
  const createCustomer = () =>
    mutation("createCustomer", {
      args: v.object({
        customer: v.object({ email: v.string() }),
        items: v.array(v.object({ price: v.number() })),
      }),
      handler: async () => 1,
    })

  it("names the field in the message, and puts the structured issues on the error", async () => {
    createCustomer()
    const err: any = await runMutation("createCustomer", { customer: {}, items: [] }, { db: fakeDb }).catch((e) => e)
    expect(err.message).toBe("Invalid args: customer.email: Invalid input: expected string, received undefined")
    expect(err.issues).toEqual([
      { path: ["customer", "email"], code: "invalid_type", message: "Invalid input: expected string, received undefined" },
    ])
  })

  it("lists every issue, the first one first", async () => {
    createCustomer()
    const err: any = await runMutation("createCustomer", { items: [{ price: "9" }] }, { db: fakeDb }).catch((e) => e)
    expect(err.message).toBe(
      "Invalid args: customer: Invalid input: expected object, received undefined; " +
        "items.0.price: Invalid input: expected number, received string"
    )
    expect(err.issues.map((i: any) => i.path)).toEqual([["customer"], ["items", 0, "price"]])
  })

  it("an issue with the args as a whole reads as it always did", async () => {
    query("whole", { args: v.object({ id: v.string() }), handler: async () => 1 })
    const err: any = await runQuery("whole", "not-an-object", { db: fakeDb }).catch((e) => e)
    expect(err.message).toBe("Invalid args: Invalid input: expected object, received string")
    expect(err.issues).toEqual([{ path: [], code: "invalid_type", message: "Invalid input: expected object, received string" }])
  })

  it("stays a plain Error, so the HTTP route's `${error}` body keeps its prefix", async () => {
    query("strictQ", { args: v.object({ id: v.string() }), handler: async () => 1 })
    const err: any = await runQuery("strictQ", {}, { db: fakeDb }).catch((e) => e)
    expect(err.name).toBe("Error")
    expect(`${err}`).toBe("Error: Invalid args: id: Invalid input: expected string, received undefined")
  })

  it("lists at most 10 issues in the message, and keeps every one on `issues`", async () => {
    query("manyItems", { args: v.object({ items: v.array(v.number()) }), handler: async () => 1 })
    const err: any = await runQuery("manyItems", { items: Array.from({ length: 25 }, (_, i) => `x${i}`) }, { db: fakeDb }).catch((e) => e)
    expect(err.message.startsWith("Invalid args: items.0: Invalid input: expected number, received string; ")).toBe(true)
    expect(err.message.match(/items\.\d+:/g)).toHaveLength(10)
    expect(err.message.endsWith("; …and 15 more")).toBe(true)
    expect(err.issues).toHaveLength(25)
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

describe("internal handler registration (review round F11)", () => {
  beforeEach(() => resetHandlers())

  // The duplicate check looked up the bare name in a map keyed `internal.<name>`, so it never
  // fired: a second internalQuery("recalc") silently replaced the first, and runInternalQuery ran
  // whichever module loaded last. It now says so. It still replaces (as it did), so an app with a
  // duplicate keeps booting — the public query()/mutation() throw, as they always have.
  it("a second internalQuery or internalMutation of one name is reported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    internalQuery("recalc", { args: v.object({}), handler: async () => 1 })
    internalQuery("recalc", { args: v.object({}), handler: async () => 2 })
    internalMutation("settle", { args: v.object({}), handler: async () => 1 })
    internalMutation("settle", { args: v.object({}), handler: async () => 2 })
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/internalQuery "recalc" is registered twice/),
      expect.stringMatching(/internalMutation "settle" is registered twice/),
    ])
    expect(await runInternalQuery("internal.recalc", {}, { db: fakeDb })).toBe(2)
    warn.mockRestore()
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
