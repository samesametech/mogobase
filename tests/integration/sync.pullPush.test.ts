import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import { MongoClient } from "mongodb"
import { connectTestMongo, getTestMongoUri, cleanCollections } from "../helpers/mongo"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { pullChanges, pushChanges, _resetUnpageableProbe } from "@/server/sync"

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

describe("pullChanges: rows sharing one updatedAt (review round F15)", () => {
  // The checkpoint is the last row's updatedAt and the next pull asks for updatedAt > it, so a
  // batch that ended inside a group of rows sharing one updatedAt skipped the rest of the group
  // for good. A soft deleteMany stamps every row it deletes with one Date.now(): deleting more rows
  // than the batch size left the rest live on every client.
  it("never ends a batch inside a group: the whole group comes, and the next pull continues after it", async () => {
    const col = DB.model("things_pullpush")
    const t = Date.now()
    for (const id of ["a", "b", "c", "d", "e"]) {
      await col.insertOne({ _id: id as any, name: id, userId: "u1", createdAt: t, updatedAt: t, deletedAt: t })
    }
    await col.insertOne({ _id: "later" as any, name: "L", userId: "u1", createdAt: t + 5, updatedAt: t + 5, deletedAt: null })
    const r1 = await pullChanges({ model: "things_pullpush", checkpoint: t - 1, batchSize: 2 })
    expect(r1.documents.map((d) => d._id).sort()).toEqual(["a", "b", "c", "d", "e"])
    expect(r1.checkpoint).toBe(t)
    const r2 = await pullChanges({ model: "things_pullpush", checkpoint: r1.checkpoint, batchSize: 2 })
    expect(r2.documents.map((d) => d._id)).toEqual(["later"])
  })
})

describe("pullChanges: rows without updatedAt (review round F16)", () => {
  // Pull sorted by { updatedAt, createdAt }: rows with no updatedAt (rows written before sync, read
  // by their createdAt) sort before every row that has one. A batch ending on such a row set the
  // checkpoint to its — recent — createdAt, and the next pull, asking for later rows, skipped the
  // rows with an older updatedAt for good.
  it("pulls in the order of each row's effective timestamp, so no row is skipped", async () => {
    const col = DB.db.collection("things_pullpush") // raw: rows as an import left them
    const now = Date.now()
    for (const id of ["r1", "r2", "r3"]) await col.insertOne({ _id: id as any, name: id, userId: "u1", createdAt: now, deletedAt: null })
    for (const id of ["old1", "old2"]) await col.insertOne({ _id: id as any, name: id, userId: "u1", createdAt: 500, updatedAt: 500, deletedAt: null })
    const pulled: string[] = []
    let checkpoint: number | null = null
    for (let i = 0; i < 10; i++) {
      const r = await pullChanges({ model: "things_pullpush", checkpoint, batchSize: 2 })
      if (!r.documents.length) break
      pulled.push(...r.documents.map((d) => String(d._id)))
      checkpoint = r.checkpoint
    }
    expect(pulled.sort()).toEqual(["old1", "old2", "r1", "r2", "r3"])
  })
})

describe("pullChanges: an updatedAt a Date (review round F17)", () => {
  // engineTimestamp accepts a Date (an import, a migration, a caller's new Date() — kept, as main
  // decided in 3.8.0: "readers must accept both"), but pull asked for updatedAt > <a number>, which
  // never matches a Date (MongoDB compares within one type): such a row was never pulled after the
  // first pull, and on the first, sorted after every number, fell outside a full batch.
  it("pulls rows whose updatedAt is a Date, in order with the rest", async () => {
    const col = DB.db.collection("things_pullpush")
    const t = Date.now()
    await col.insertOne({ _id: "num1" as any, name: "n", userId: "u1", createdAt: t - 3000, updatedAt: t - 3000, deletedAt: null })
    await col.insertOne({ _id: "date1" as any, name: "d", userId: "u1", createdAt: t - 2000, updatedAt: new Date(t - 2000), deletedAt: null })
    await col.insertOne({ _id: "num2" as any, name: "n", userId: "u1", createdAt: t - 1000, updatedAt: t - 1000, deletedAt: null })
    const pulled: string[] = []
    let checkpoint: number | null = t - 5000
    for (let i = 0; i < 10; i++) {
      const r = await pullChanges({ model: "things_pullpush", checkpoint, batchSize: 1 })
      if (!r.documents.length) break
      pulled.push(...r.documents.map((d) => String(d._id)))
      checkpoint = r.checkpoint
    }
    expect(pulled).toEqual(["num1", "date1", "num2"])
  })
})

describe("pullChanges: rows without a numeric updatedAt (review round F18)", () => {
  // Round F17's reads (number, Date, missing) missed a string updatedAt — which main's first pull
  // returned — sorted rows without one by createdAt in BSON order (every number before every Date),
  // and rows with no timestamp at all (effective 0) answered checkpoint 0, which reads as "from the
  // start": a full batch of them was pulled again for ever. Such rows are now read apart and
  // ordered by their effective timestamp in JS, and a checkpoint never answers 0 for a row.
  const pullAll = async (batchSize: number) => {
    const pulled: string[] = []
    let checkpoint: number | null = null
    for (let i = 0; i < 20; i++) {
      const r = await pullChanges({ model: "things_pullpush", checkpoint, batchSize })
      if (!r.documents.length) break
      pulled.push(...r.documents.map((d) => String(d._id)))
      if (r.documents.length < batchSize) break
      checkpoint = r.checkpoint
    }
    return pulled
  }

  // Round F20: reading such rows correctly at pull time cost a scan of the collection on every
  // pull and broke policies filtering with $where; a pull reads index ranges only, and the rows it
  // cannot page (a string stamp, a Date createdAt, no stamp at all) are warned about once, with the
  // one-off updateMany that stamps them. What it pulls, it pulls in order, never twice, never
  // looping; rows with no timestamp come in the first batch only.
  it("pulls rows with no updatedAt by their createdAt, without looping on rows with no timestamp, and warns about the rest", async () => {
    _resetUnpageableProbe() // earlier cases probed this model before it had such rows
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const col = DB.db.collection("things_pullpush")
    await col.insertOne({ _id: "str" as any, name: "s", userId: "u1", updatedAt: "2020-01-01T00:00:00.000Z", deletedAt: null })
    for (const id of ["bare1", "bare2"]) await col.insertOne({ _id: id as any, name: id, userId: "u1", deletedAt: null })
    await col.insertOne({ _id: "cNum" as any, name: "c", userId: "u1", createdAt: 2000, deletedAt: null })
    await col.insertOne({ _id: "num" as any, name: "n", userId: "u1", createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null })
    const pulled = await pullAll(2)
    expect(pulled.length).toBe(new Set(pulled).size) // no row twice: no loop
    expect(pulled).toEqual(["bare1", "bare2", "cNum", "num"])
    expect(warn.mock.calls.some((c) => /things_pullpush has rows sync cannot page/.test(String(c[0])))).toBe(true)
    warn.mockRestore()
  })

  it("a policy filter with $where still pulls (no aggregation $match refuses it)", async () => {
    const col = DB.model("things_pullpush")
    const t = Date.now()
    await col.insertOne({ _id: "w1" as any, name: "w", userId: "u1", createdAt: t, updatedAt: t, deletedAt: null })
    const r = await pullChanges({ model: "things_pullpush", checkpoint: null, extraFilter: { $where: "this.userId === 'u1'" } })
    expect(r.documents.map((d) => d._id)).toEqual(["w1"])
  })
})

describe("pullChanges: parity with main on a first pull (advisor review)", () => {
  // Order and checkpoint used pickEffectiveTimestamp, but the reads select by BSON type: a row
  // with a string updatedAt, or no updatedAt and a Date or string createdAt, was selected by no
  // read — main's first pull ({}) returned them. Rows are now ordered, completed and checkpointed
  // by a page key the reads can express (0 for these: a first pull offers them, before the rest).
  it("a first pull returns string-stamped rows and rows with a Date or string createdAt, as main did", async () => {
    const col = DB.db.collection("things_pullpush")
    const T = 1_700_000_000_000
    await col.insertMany([
      { _id: "n1", name: "n", userId: "u1", updatedAt: T, createdAt: T, deletedAt: null },
      { _id: "s1", name: "s", userId: "u1", updatedAt: "2024-05-01T00:00:00.000Z", deletedAt: null },
      { _id: "dc", name: "d", userId: "u1", createdAt: new Date(T + 100_000), deletedAt: null },
      { _id: "sc", name: "c", userId: "u1", createdAt: "2024-05-01T00:00:00.000Z", deletedAt: null },
    ] as any[])
    const r = await pullChanges({ model: "things_pullpush", checkpoint: null, batchSize: 200 })
    expect(r.documents.map((d) => String(d._id)).sort()).toEqual(["dc", "n1", "s1", "sc"])
  })

  // A checkpoint past the range of a Date (a row stamped 1.7e18) made new Date(since) invalid, and
  // the Date read answered every Date-stamped row again, with an older checkpoint: a ping-pong.
  it("a checkpoint beyond the range of a Date does not bring the Date-stamped rows back", async () => {
    const col = DB.db.collection("things_pullpush")
    const T = 1_700_000_000_000
    await col.insertMany([
      { _id: "d1", name: "d", userId: "u1", updatedAt: new Date(T), deletedAt: null },
      { _id: "ns", name: "n", userId: "u1", updatedAt: 1.7e18, createdAt: T, deletedAt: null },
    ] as any[])
    const first = await pullChanges({ model: "things_pullpush", checkpoint: null })
    expect(first.checkpoint).toBe(1.7e18)
    const second = await pullChanges({ model: "things_pullpush", checkpoint: first.checkpoint })
    expect(second.documents).toEqual([])
  })
})
