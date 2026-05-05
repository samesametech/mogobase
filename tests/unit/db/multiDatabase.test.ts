// tests/unit/db/multiDatabase.test.ts
//
// Unit tests for the multi-database primitives on MogobaseDB:
//   - setRequestResolver / _resolveActive
//   - registerDatabase / useRawDatabase
//   - useDatabase + view caching + lazy index application
//
// Real MongoDB is not used. We reset the singleton's internal state in
// beforeEach and stub out MongoClient.connect when a code path needs to
// connect to a previously-unseen URI.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import DB from "@/db"
import { MongoClient } from "mongodb"

type FakeCollection = {
  _name: string
  _dbName: string
  _indexes: any[]
  createIndexes: (specs: any[]) => Promise<string[]>
  insertOne: (doc: any) => Promise<any>
  find: () => { toArray: () => Promise<any[]> }
}

type FakeDb = {
  _name: string
  collection: (colName: string) => FakeCollection
  createCollection: (colName: string) => Promise<FakeCollection>
}

type FakeClient = {
  _uri: string
  db: (name: string) => FakeDb
  close: () => Promise<void>
}

function makeFakeCollection(colName: string, dbName: string): FakeCollection {
  const indexes: any[] = []
  return {
    _name: colName,
    _dbName: dbName,
    _indexes: indexes,
    createIndexes: async (specs: any[]) => {
      for (const s of specs) indexes.push(s)
      return specs.map((s) => s?.name ?? colName)
    },
    insertOne: async (_doc: any) => ({ acknowledged: true, insertedId: "fake-id" }),
    find: () => ({ toArray: async () => [] }),
  }
}

function makeFakeDb(name: string): FakeDb {
  const colCache = new Map<string, FakeCollection>()
  const get = (colName: string) => {
    let c = colCache.get(colName)
    if (!c) {
      c = makeFakeCollection(colName, name)
      colCache.set(colName, c)
    }
    return c
  }
  return {
    _name: name,
    collection: get,
    createCollection: async (colName: string) => get(colName),
  }
}

function makeFakeClient(uri: string): FakeClient {
  const dbCache = new Map<string, FakeDb>()
  return {
    _uri: uri,
    db: (name: string) => {
      let d = dbCache.get(name)
      if (!d) {
        d = makeFakeDb(name)
        dbCache.set(name, d)
      }
      return d
    },
    close: async () => {},
  }
}

const DEFAULT_URI = "fake://default"
const DEFAULT_DB = "default"

function resetDb(): FakeClient {
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

describe("MogobaseDB.setRequestResolver", () => {
  beforeEach(() => {
    resetDb()
  })

  it("stores the resolver", () => {
    const fn = () => null
    DB.setRequestResolver(fn)
    expect((DB as any)._resolver).toBe(fn)
  })

  it("replaces a previously registered resolver", () => {
    const a = () => null
    const b = () => null
    DB.setRequestResolver(a)
    DB.setRequestResolver(b)
    expect((DB as any)._resolver).toBe(b)
  })

  it("clears the resolver when passed null", () => {
    DB.setRequestResolver(() => null)
    DB.setRequestResolver(null)
    expect((DB as any)._resolver).toBeUndefined()
  })
})

describe("MogobaseDB._resolveActive", () => {
  beforeEach(() => {
    resetDb()
  })

  it("returns the singleton when no resolver is registered", async () => {
    const active = await (DB as any)._resolveActive({})
    expect(active).toBe(DB)
  })

  it("returns the singleton when the resolver returns null", async () => {
    DB.setRequestResolver(() => null)
    const active = await (DB as any)._resolveActive({})
    expect(active).toBe(DB)
  })

  it("returns the singleton when the resolver returns undefined", async () => {
    DB.setRequestResolver(() => undefined)
    const active = await (DB as any)._resolveActive({})
    expect(active).toBe(DB)
  })

  it("returns a view bound to the resolved dbName when the resolver returns a string", async () => {
    DB.setRequestResolver(({ headers }: any) => headers?.tenant ?? null)
    const active = await (DB as any)._resolveActive({ tenant: "tenant_a" })
    expect(active).not.toBe(DB)
    expect(active.db._name).toBe("tenant_a")
  })

  it("supports async resolvers", async () => {
    DB.setRequestResolver(async ({ headers }: any) => {
      await Promise.resolve()
      return headers?.tenant ?? null
    })
    const active = await (DB as any)._resolveActive({ tenant: "tenant_b" })
    expect(active.db._name).toBe("tenant_b")
  })

  it("passes headers through to the resolver", async () => {
    const seen: any[] = []
    DB.setRequestResolver(({ headers }: any) => {
      seen.push(headers)
      return null
    })
    await (DB as any)._resolveActive({ x: 1 })
    expect(seen).toEqual([{ x: 1 }])
  })

  it("throws a descriptive error when the resolver throws", async () => {
    DB.setRequestResolver(() => {
      throw new Error("boom")
    })
    await expect((DB as any)._resolveActive({})).rejects.toThrow(/DB resolver threw: boom/)
  })

  it("throws when the resolver returns an unsupported value", async () => {
    DB.setRequestResolver((() => 42) as any)
    await expect((DB as any)._resolveActive({})).rejects.toThrow(/unsupported value/)
  })

  it("returns the same view across requests for the same tenant", async () => {
    DB.setRequestResolver(({ headers }: any) => headers?.tenant ?? null)
    const a = await (DB as any)._resolveActive({ tenant: "shared" })
    const b = await (DB as any)._resolveActive({ tenant: "shared" })
    expect(a).toBe(b)
  })
})

describe("MogobaseDB.useDatabase", () => {
  beforeEach(() => {
    resetDb()
  })

  it("throws if connect() hasn't been called", () => {
    const anyDb = DB as any
    anyDb._mongoClient = undefined
    anyDb._defaultUri = undefined
    expect(() => DB.useDatabase("any")).toThrow(/Call connect\(\) first/)
  })

  it("requires a non-empty dbName", () => {
    expect(() => DB.useDatabase("")).toThrow(/useDatabase requires a dbName/)
  })

  it("returns a view bound to the requested dbName on the default cluster", () => {
    const view = DB.useDatabase("tenant_x") as any
    expect(view.db._name).toBe("tenant_x")
    expect(view.client._uri).toBe(DEFAULT_URI)
  })

  it("caches views by (uri, dbName) — same instance across calls", () => {
    const a = DB.useDatabase("tenant_x")
    const b = DB.useDatabase("tenant_x")
    expect(a).toBe(b)
  })

  it("returns distinct views for distinct dbNames", () => {
    const a = DB.useDatabase("tenant_x")
    const b = DB.useDatabase("tenant_y")
    expect(a).not.toBe(b)
  })

  it("view shares the same schema registry as the parent singleton", () => {
    const view = DB.useDatabase("tenant_x") as any
    ;(DB as any)._schemas.set("posts", { schema: { foo: 1 } })
    expect(view.getSchema("posts")).toEqual({ schema: { foo: 1 } })
  })

  it("view delegates useDatabase / useRawDatabase / setRequestResolver back to parent", () => {
    const view = DB.useDatabase("tenant_x") as any
    const inner = view.useDatabase("tenant_z")
    expect(inner).toBe(DB.useDatabase("tenant_z"))
  })
})

describe("MogobaseDB.registerDatabase", () => {
  beforeEach(() => {
    resetDb()
  })

  it("stores an alias with explicit uri + dbName", () => {
    DB.registerDatabase("analytics", { uri: "fake://analytics", dbName: "events" })
    const aliases = (DB as any)._rawAliases as Map<string, any>
    expect(aliases.get("analytics")).toEqual({ uri: "fake://analytics", dbName: "events" })
  })

  it("defaults the uri to the default cluster when omitted", () => {
    DB.registerDatabase("legacy", { dbName: "legacy_db" })
    const aliases = (DB as any)._rawAliases as Map<string, any>
    expect(aliases.get("legacy")).toEqual({ uri: DEFAULT_URI, dbName: "legacy_db" })
  })

  it("throws on duplicate alias name", () => {
    DB.registerDatabase("analytics", { uri: "fake://analytics", dbName: "events" })
    expect(() => DB.registerDatabase("analytics", { dbName: "x" })).toThrow(/already registered/)
  })

  it("requires a non-empty name and dbName", () => {
    expect(() => DB.registerDatabase("", { dbName: "x" } as any)).toThrow(/registerDatabase requires/)
    expect(() => DB.registerDatabase("a", { dbName: "" } as any)).toThrow(/registerDatabase requires/)
    expect(() => DB.registerDatabase("a", undefined as any)).toThrow(/registerDatabase requires/)
  })
})

describe("MogobaseDB.useRawDatabase", () => {
  beforeEach(() => {
    resetDb()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("throws when the alias is not registered", async () => {
    await expect(DB.useRawDatabase("nope")).rejects.toThrow(/not registered/)
  })

  it("resolves a same-cluster alias against the cached default client", async () => {
    DB.registerDatabase("legacy", { dbName: "legacy_db" })
    const db = (await DB.useRawDatabase("legacy")) as unknown as FakeDb
    expect(db._name).toBe("legacy_db")
  })

  it("resolves a different-cluster alias against a pre-populated client", async () => {
    const altClient = makeFakeClient("fake://alt")
    ;(DB as any)._clients.set("fake://alt", altClient)
    DB.registerDatabase("analytics", { uri: "fake://alt", dbName: "events" })
    const db = (await DB.useRawDatabase("analytics")) as unknown as FakeDb
    expect(db._name).toBe("events")
    // Same client object as the one we pre-populated.
    expect((DB as any)._clients.get("fake://alt")).toBe(altClient)
  })

  it("lazily connects a previously-unseen URI on first use", async () => {
    const altClient = makeFakeClient("fake://lazy")
    const spy = vi.spyOn(MongoClient, "connect").mockResolvedValue(altClient as any)
    DB.registerDatabase("lazy", { uri: "fake://lazy", dbName: "ldb" })

    const db = (await DB.useRawDatabase("lazy")) as unknown as FakeDb
    expect(spy).toHaveBeenCalledWith("fake://lazy")
    expect(db._name).toBe("ldb")

    // Second call reuses the cached client — no second connect.
    const again = (await DB.useRawDatabase("lazy")) as unknown as FakeDb
    expect(spy).toHaveBeenCalledTimes(1)
    expect(again._name).toBe("ldb")
  })

  it("does not autoStamp or apply mogobase indexes on the raw db", async () => {
    DB.registerDatabase("legacy", { dbName: "legacy_db" })
    const rawDb = (await DB.useRawDatabase("legacy")) as unknown as FakeDb
    const col = rawDb.collection("posts")
    // Raw collection — calling insertOne shouldn't touch any mogobase Proxy.
    await col.insertOne({ title: "raw" })
    // No indexes were ever applied via _ensureModelApplied for this raw access.
    expect(col._indexes.length).toBe(0)
  })
})

describe("MogobaseDB view: lazy model index application", () => {
  beforeEach(() => {
    resetDb()
  })

  it("applies a registered model's indexes the first time view.model(name) is called", async () => {
    // Pre-register a model on the parent (schemas only — no eager apply).
    ;(DB as any)._schemas.set("posts", { schema: { x: 1 } })

    const view = DB.useDatabase("tenant_a") as any
    const col = view.model("posts")

    // _ensureModelApplied is fire-and-forget; wait for it to settle.
    await new Promise((r) => setTimeout(r, 10))

    const tenantApplied = (DB as any)._appliedModels.get("fake://default::tenant_a") as Set<string>
    expect(tenantApplied.has("posts")).toBe(true)

    // Sync-checkpoint indexes were created.
    const names = (col._indexes as any[]).map((s) => s?.name)
    expect(names).toContain("mogobase_updatedAt_1")
    expect(names).toContain("mogobase_deletedAt_1")
    expect(names).toContain("mogobase_createdAt_1")
  })

  it("does not re-apply indexes on subsequent model() calls", async () => {
    ;(DB as any)._schemas.set("posts", { schema: { x: 1 } })

    const view = DB.useDatabase("tenant_b") as any
    view.model("posts")
    await new Promise((r) => setTimeout(r, 10))
    const col = view.model("posts")
    await new Promise((r) => setTimeout(r, 10))
    view.model("posts")
    await new Promise((r) => setTimeout(r, 10))

    // Each createIndexes call appends 3 entries (sync-checkpoint indexes).
    // Only the first model() access should have triggered them.
    expect(col._indexes.length).toBe(3)
  })

  it("applies only sync-checkpoint indexes for an unregistered model", async () => {
    const view = DB.useDatabase("tenant_c") as any
    const col = view.model("strangers")
    await new Promise((r) => setTimeout(r, 10))
    const names = (col._indexes as any[]).map((s) => s?.name)
    expect(names).toEqual(
      expect.arrayContaining(["mogobase_updatedAt_1", "mogobase_deletedAt_1", "mogobase_createdAt_1"])
    )
  })

  it("tracks applied-models per (uri, dbName) pair independently", async () => {
    ;(DB as any)._schemas.set("posts", { schema: { x: 1 } })

    DB.useDatabase("tenant_a").model("posts")
    DB.useDatabase("tenant_b").model("posts")
    await new Promise((r) => setTimeout(r, 10))

    const a = (DB as any)._appliedModels.get("fake://default::tenant_a") as Set<string>
    const b = (DB as any)._appliedModels.get("fake://default::tenant_b") as Set<string>
    expect(a.has("posts")).toBe(true)
    expect(b.has("posts")).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe("MogobaseDB view: defineModel", () => {
  beforeEach(() => {
    resetDb()
  })

  it("registers schema in the parent registry and applies indexes to the view's db", async () => {
    const view = DB.useDatabase("tenant_define") as any
    await view.defineModel("widgets", { foo: 1 }, { indexSpecs: [{ key: { foo: 1 }, name: "foo_1" }] })

    expect((DB as any)._schemas.get("widgets")).toBeDefined()
    expect(DB.getSchema("widgets")).toBeDefined()

    const col = view.db.collection("widgets")
    const names = (col._indexes as any[]).map((s: any) => s?.name)
    expect(names).toContain("foo_1")
    expect(names).toContain("mogobase_updatedAt_1")
  })
})
