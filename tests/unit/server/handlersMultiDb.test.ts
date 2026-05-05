// tests/unit/server/handlersMultiDb.test.ts
//
// Integration of the multi-DB primitives with _runQuery / _runMutation:
//   - resolver fires once at the entry boundary (not on recursive calls)
//   - ctx.useDatabase / ctx.useRawDatabase wired into the handler ctx
//   - mutation ctx wraps useDatabase result with autoStamp; raw is untouched

import { describe, it, expect, beforeEach } from "vitest"
import handlers, { query, mutation, internalMutation, runQuery, runMutation, v } from "@/server/handlers"
import DB from "@/db"

type FakeCollection = {
  _name: string
  _dbName: string
  _inserts: any[]
  _indexes: any[]
  insertOne: (doc: any) => Promise<any>
  createIndexes: (specs: any[]) => Promise<string[]>
  find: () => { toArray: () => Promise<any[]> }
}

type FakeDb = {
  _name: string
  collection: (name: string) => FakeCollection
  createCollection: (name: string) => Promise<FakeCollection>
}

type FakeClient = {
  _uri: string
  db: (name: string) => FakeDb
  close: () => Promise<void>
}

function makeFakeCollection(colName: string, dbName: string): FakeCollection {
  const inserts: any[] = []
  const indexes: any[] = []
  return {
    _name: colName,
    _dbName: dbName,
    _inserts: inserts,
    _indexes: indexes,
    insertOne: async (doc: any) => {
      inserts.push(doc)
      return { acknowledged: true, insertedId: "id" }
    },
    createIndexes: async (specs: any[]) => {
      for (const s of specs) indexes.push(s)
      return specs.map((s) => s?.name ?? colName)
    },
    find: () => ({ toArray: async () => [] }),
  }
}

function makeFakeDb(name: string): FakeDb {
  const cache = new Map<string, FakeCollection>()
  const get = (n: string) => {
    let c = cache.get(n)
    if (!c) {
      c = makeFakeCollection(n, name)
      cache.set(n, c)
    }
    return c
  }
  return {
    _name: name,
    collection: get,
    createCollection: async (n: string) => get(n),
  }
}

function makeFakeClient(uri: string): FakeClient {
  const dbCache = new Map<string, FakeDb>()
  return {
    _uri: uri,
    db: (n: string) => {
      let d = dbCache.get(n)
      if (!d) {
        d = makeFakeDb(n)
        dbCache.set(n, d)
      }
      return d
    },
    close: async () => {},
  }
}

const DEFAULT_URI = "fake://default"
const DEFAULT_DB = "default"

function reset(): FakeClient {
  handlers.queries.clear()
  handlers.mutations.clear()
  handlers._queries.clear()
  handlers._mutations.clear()

  const anyDb = DB as any
  anyDb._views.clear()
  anyDb._rawAliases.clear()
  anyDb._appliedModels.clear()
  anyDb._clients.clear()
  anyDb._schemas.clear()
  anyDb._resolver = undefined
  anyDb._modelsBound = false

  const fakeClient = makeFakeClient(DEFAULT_URI)
  anyDb._mongoClient = fakeClient
  anyDb._db = fakeClient.db(DEFAULT_DB)
  anyDb._defaultUri = DEFAULT_URI
  anyDb._defaultDbName = DEFAULT_DB
  anyDb._clients.set(DEFAULT_URI, fakeClient)
  anyDb._appliedModels.set(`${DEFAULT_URI}::${DEFAULT_DB}`, new Set())
  return fakeClient
}

describe("resolver wiring through _runQuery", () => {
  beforeEach(() => {
    reset()
  })

  it("ctx.db points at the resolved view when the resolver returns a string", async () => {
    DB.setRequestResolver(({ headers }: any) => headers?.tenant ?? null)
    query("whoami", {
      args: v.object({}),
      handler: async (_a, ctx) => (ctx.db as any).db._name,
    })
    const dbName = await runQuery("whoami", {}, { db: DB, headers: { tenant: "tenant_a" } })
    expect(dbName).toBe("tenant_a")
  })

  it("ctx.db stays as the singleton DB when resolver returns null", async () => {
    DB.setRequestResolver(() => null)
    query("whoami", {
      args: v.object({}),
      handler: async (_a, ctx) => (ctx.db as any).db._name,
    })
    const dbName = await runQuery("whoami", {}, { db: DB, headers: {} })
    expect(dbName).toBe(DEFAULT_DB)
  })

  it("ctx.db stays as the singleton DB when no resolver is registered", async () => {
    query("whoami", {
      args: v.object({}),
      handler: async (_a, ctx) => (ctx.db as any).db._name,
    })
    const dbName = await runQuery("whoami", {}, { db: DB, headers: {} })
    expect(dbName).toBe(DEFAULT_DB)
  })

  it("resolver runs only once per request, not on recursive ctx.runQuery calls", async () => {
    let calls = 0
    DB.setRequestResolver(({ headers }: any) => {
      calls += 1
      return headers?.tenant ?? null
    })
    query("inner", {
      args: v.object({}),
      handler: async (_a, ctx) => (ctx.db as any).db._name,
    })
    query("outer", {
      args: v.object({}),
      handler: async (_a, ctx) => {
        const inner = await ctx.runQuery("inner", {})
        return { outer: (ctx.db as any).db._name, inner }
      },
    })
    const res = await runQuery("outer", {}, { db: DB, headers: { tenant: "tenant_x" } })
    expect(res).toEqual({ outer: "tenant_x", inner: "tenant_x" })
    expect(calls).toBe(1)
  })

  it("resolver throw surfaces as a request error", async () => {
    DB.setRequestResolver(() => {
      throw new Error("nope")
    })
    query("anything", { args: v.object({}), handler: async () => 1 })
    await expect(runQuery("anything", {}, { db: DB, headers: {} })).rejects.toThrow(/DB resolver threw/)
  })
})

describe("ctx.useDatabase / ctx.useRawDatabase wiring", () => {
  beforeEach(() => {
    reset()
  })

  it("ctx.useDatabase returns a view bound to the requested dbName", async () => {
    query("byTenant", {
      args: v.object({ name: v.string() }),
      handler: async (args, ctx) => (ctx.useDatabase(args.name) as any).db._name,
    })
    const res = await runQuery("byTenant", { name: "tenant_q" }, { db: DB })
    expect(res).toBe("tenant_q")
  })

  it("ctx.useDatabase is cached — same instance across calls in the same request", async () => {
    query("dup", {
      args: v.object({}),
      handler: async (_a, ctx) => {
        const a = ctx.useDatabase("tenant_dup")
        const b = ctx.useDatabase("tenant_dup")
        return a === b
      },
    })
    const same = await runQuery("dup", {}, { db: DB })
    expect(same).toBe(true)
  })

  it("ctx.useRawDatabase resolves a registered alias", async () => {
    DB.registerDatabase("legacy", { dbName: "legacy_db" })
    query("legacy", {
      args: v.object({}),
      handler: async (_a, ctx) => {
        const raw = await ctx.useRawDatabase("legacy")
        return (raw as any)._name
      },
    })
    const res = await runQuery("legacy", {}, { db: DB })
    expect(res).toBe("legacy_db")
  })

  it("ctx.useRawDatabase rejects when alias is not registered", async () => {
    query("missing", {
      args: v.object({}),
      handler: async (_a, ctx) => {
        await ctx.useRawDatabase("does_not_exist")
        return null
      },
    })
    await expect(runQuery("missing", {}, { db: DB })).rejects.toThrow(/not registered/)
  })
})

describe("autoStamp behaviour across ctx.db / useDatabase / useRawDatabase in mutations", () => {
  beforeEach(() => {
    reset()
  })

  it("ctx.db in a mutation is autoStamp-wrapped (insert injects timestamps)", async () => {
    DB.setRequestResolver(({ headers }: any) => headers?.tenant ?? null)
    mutation("createOnDefault", {
      args: v.object({ title: v.string() }),
      handler: async (args, ctx) => {
        await ctx.db.model("posts").insertOne({ title: args.title })
      },
    })
    await runMutation("createOnDefault", { title: "hi" }, { db: DB, headers: { tenant: "tenant_z" } })

    const fakeClient = (DB as any)._clients.get(DEFAULT_URI) as FakeClient
    const tenantDb = fakeClient.db("tenant_z")
    const inserts = tenantDb.collection("posts")._inserts
    expect(inserts.length).toBe(1)
    expect(typeof inserts[0].createdAt).toBe("number")
    expect(typeof inserts[0].updatedAt).toBe("number")
    expect(inserts[0].deletedAt).toBeNull()
    expect(inserts[0].title).toBe("hi")
  })

  it("ctx.useDatabase in a mutation returns an autoStamp-wrapped view", async () => {
    mutation("createOnTenant", {
      args: v.object({ tenant: v.string(), title: v.string() }),
      handler: async (args, ctx) => {
        const tenantDb = ctx.useDatabase(args.tenant)
        await tenantDb.model("posts").insertOne({ title: args.title })
      },
    })
    await runMutation("createOnTenant", { tenant: "tenant_a", title: "x" }, { db: DB })

    const fakeClient = (DB as any)._clients.get(DEFAULT_URI) as FakeClient
    const inserts = fakeClient.db("tenant_a").collection("posts")._inserts
    expect(inserts.length).toBe(1)
    expect(typeof inserts[0].createdAt).toBe("number")
    expect(typeof inserts[0].updatedAt).toBe("number")
    expect(inserts[0].deletedAt).toBeNull()
  })

  it("ctx.useRawDatabase is NOT autoStamp-wrapped — raw insert lands as-is", async () => {
    DB.registerDatabase("legacy", { dbName: "legacy_db" })
    mutation("rawInsert", {
      args: v.object({}),
      handler: async (_a, ctx) => {
        const raw = await ctx.useRawDatabase("legacy")
        await raw.collection("things").insertOne({ name: "raw" })
      },
    })
    await runMutation("rawInsert", {}, { db: DB })

    const fakeClient = (DB as any)._clients.get(DEFAULT_URI) as FakeClient
    const inserts = fakeClient.db("legacy_db").collection("things")._inserts
    expect(inserts.length).toBe(1)
    expect(inserts[0]).toEqual({ name: "raw" })
    expect(inserts[0].createdAt).toBeUndefined()
    expect(inserts[0].updatedAt).toBeUndefined()
    expect(inserts[0].deletedAt).toBeUndefined()
  })

  it("recursive runMutation through ctx.runMutation inherits the resolved DB without re-running resolver", async () => {
    let calls = 0
    DB.setRequestResolver(({ headers }: any) => {
      calls += 1
      return headers?.tenant ?? null
    })
    internalMutationRegister()

    mutation("outer", {
      args: v.object({ title: v.string() }),
      handler: async (args, ctx) => {
        await ctx.runMutation("internal.write", { title: args.title })
        return (ctx.db as any).db._name
      },
    })

    const dbName = await runMutation(
      "outer",
      { title: "hi" },
      { db: DB, headers: { tenant: "tenant_inner" } }
    )
    expect(dbName).toBe("tenant_inner")
    expect(calls).toBe(1)

    const fakeClient = (DB as any)._clients.get(DEFAULT_URI) as FakeClient
    const inserts = fakeClient.db("tenant_inner").collection("posts")._inserts
    expect(inserts.length).toBe(1)
    expect(inserts[0].title).toBe("hi")
    expect(typeof inserts[0].createdAt).toBe("number")
  })
})

// Helper: register the internal handler used by the recursive-mutation test.
// Defined here so the test body stays focused on the assertions.
function internalMutationRegister() {
  internalMutation("write", {
    args: v.object({ title: v.string() }),
    handler: async (args: any, ctx: any) => {
      await ctx.db.model("posts").insertOne({ title: args.title })
    },
  })
}
