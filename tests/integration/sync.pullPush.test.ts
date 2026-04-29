import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient } from "mongodb"
import { connectTestMongo, getTestMongoUri, cleanCollections } from "../helpers/mongo"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { pullChanges, pushChanges } from "@/server/sync"

let client: MongoClient

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel("things_pullpush", undefined, { sync: true, clientFields: ["name", "userId"] })
  client = (await connectTestMongo("mogobase_test_integration")).client
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  const { db } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, ["things_pullpush"])
})

describe("pullChanges", () => {
  it("returns docs newer than checkpoint and advances checkpoint", async () => {
    const col = DB.model("things_pullpush")
    const t0 = Date.now()
    await col.insertOne({ _id: "a" as any, name: "A", userId: "u1", createdAt: t0, updatedAt: t0, deletedAt: null })
    await col.insertOne({ _id: "b" as any, name: "B", userId: "u1", createdAt: t0 + 1, updatedAt: t0 + 1, deletedAt: null })

    const r1 = await pullChanges({ model: "things_pullpush", checkpoint: null })
    expect(r1.documents.map((d) => d._id)).toEqual(["a", "b"])
    expect(r1.checkpoint).toBe(t0 + 1)

    await col.insertOne({ _id: "c" as any, name: "C", userId: "u1", createdAt: t0 + 2, updatedAt: t0 + 2, deletedAt: null })

    const r2 = await pullChanges({ model: "things_pullpush", checkpoint: r1.checkpoint })
    expect(r2.documents.map((d) => d._id)).toEqual(["c"])
  })

  it("propagates tombstones (deletedAt set)", async () => {
    const col = DB.model("things_pullpush")
    const t0 = Date.now()
    await col.insertOne({ _id: "x" as any, name: "X", userId: "u1", createdAt: t0, updatedAt: t0, deletedAt: null })
    await col.updateOne({ _id: "x" as any }, { $set: { deletedAt: t0 + 100, updatedAt: t0 + 100 } })

    const r = await pullChanges({ model: "things_pullpush", checkpoint: t0 })
    const dx = r.documents.find((d) => d._id === "x")
    expect(dx).toBeDefined()
    expect(dx!._deleted).toBe(true)
    expect(dx!.deletedAt).toBe(t0 + 100)
  })

  it("applies extraFilter", async () => {
    const col = DB.model("things_pullpush")
    const t0 = Date.now()
    await col.insertMany([
      { _id: "a" as any, name: "A", userId: "u1", createdAt: t0, updatedAt: t0, deletedAt: null },
      { _id: "b" as any, name: "B", userId: "u2", createdAt: t0 + 1, updatedAt: t0 + 1, deletedAt: null },
    ])
    const r = await pullChanges({ model: "things_pullpush", checkpoint: null, extraFilter: { userId: "u1" } })
    expect(r.documents.map((d) => d._id)).toEqual(["a"])
  })

  it("projects to clientFields ∪ engine fields", async () => {
    const col = DB.model("things_pullpush")
    const t0 = Date.now()
    await col.insertOne({
      _id: "a" as any,
      name: "A",
      userId: "u1",
      secret: "should-not-leak",
      createdAt: t0,
      updatedAt: t0,
      deletedAt: null,
    })
    const r = await pullChanges({ model: "things_pullpush", checkpoint: null })
    const d = r.documents[0] as any
    expect(d.name).toBe("A")
    expect(d.userId).toBe("u1")
    expect(d.secret).toBeUndefined()
  })

  it("throws for un-syncable model", async () => {
    defineModel("private_log") // sync NOT set
    await expect(pullChanges({ model: "private_log", checkpoint: null })).rejects.toThrow(/not configured for sync/)
  })
})

describe("pushChanges", () => {
  it("inserts a new doc and stamps server timestamps", async () => {
    const r = await pushChanges({
      model: "things_pullpush",
      rows: [{ newDocumentState: { _id: "x", name: "x1", userId: "u1" } }] as any,
    })
    expect(r.conflicts).toEqual([])
    const stored = await DB.model("things_pullpush").findOne({ _id: "x" as any }) as any
    expect(stored.name).toBe("x1")
    expect(stored.createdAt).toBeTypeOf("number")
    expect(stored.updatedAt).toBeTypeOf("number")
    expect(stored.deletedAt).toBeNull()
  })

  it("returns server doc as conflict when assumedMasterState is stale", async () => {
    await DB.model("things_pullpush").insertOne({
      _id: "y" as any, name: "server", userId: "u1",
      createdAt: 1000, updatedAt: 5000, deletedAt: null,
    })
    const r = await pushChanges({
      model: "things_pullpush",
      rows: [{
        newDocumentState: { _id: "y", name: "client", userId: "u1", updatedAt: 6000 },
        assumedMasterState: { _id: "y", name: "old-version", updatedAt: 1000 },
      }] as any,
    })
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].name).toBe("server") // server-wins
  })

  it("strips client-only fields (not in clientFields) on push", async () => {
    await pushChanges({
      model: "things_pullpush",
      rows: [{ newDocumentState: { _id: "z", name: "z1", userId: "u1", role: "admin" /* not allowed */ } }] as any,
    })
    const stored = await DB.model("things_pullpush").findOne({ _id: "z" as any }) as any
    expect(stored.role).toBeUndefined()
  })

  it("ignores client updatedAt and uses server clock", async () => {
    const t0 = Date.now()
    await pushChanges({
      model: "things_pullpush",
      rows: [{ newDocumentState: { _id: "t", name: "t1", userId: "u1", updatedAt: 9999999999999 } }] as any,
    })
    const stored = await DB.model("things_pullpush").findOne({ _id: "t" as any }) as any
    expect(stored.updatedAt).toBeGreaterThanOrEqual(t0)
    expect(stored.updatedAt).toBeLessThan(9999999999999)
  })

  it("rejects an over-cap batch with a single error", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      newDocumentState: { _id: `r${i}`, name: "r", userId: "u1" },
    }))
    await expect(pushChanges({ model: "things_pullpush", rows: rows as any })).rejects.toThrow(/exceeds 500 rows/)
  })

  it("transform throw becomes a conflict, doc not written", async () => {
    await DB.model("things_pullpush").insertOne({
      _id: "g" as any, name: "server", userId: "u1",
      createdAt: 1000, updatedAt: 1000, deletedAt: null,
    })
    const r = await pushChanges({
      model: "things_pullpush",
      rows: [{ newDocumentState: { _id: "g", name: "client", userId: "u1" } }] as any,
      transform: () => { throw new Error("policy reject") },
    })
    expect(r.conflicts).toHaveLength(1)
    const stored = await DB.model("things_pullpush").findOne({ _id: "g" as any }) as any
    expect(stored.name).toBe("server") // unchanged
  })
})
