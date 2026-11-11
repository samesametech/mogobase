// Integration tests for MongoDB time-series collections.
//
// Verifies:
//   1. defineModel({ timeseries: ... }) actually creates a time-series
//      collection in MongoDB (probed via listCollections.type).
//   2. autoStamp inserts work through a handler (createdAt/updatedAt stamped,
//      deletedAt skipped).
//   3. `mongo-cursor-pagination` paginates a time-series collection.
//   4. `buildFilters({ ... })` filters work transparently — the auto-injected
//      `deletedAt: null` matches docs without the field.
//   5. Sync operations (pullChanges) reject time-series models with a clear
//      error.
//
// Requires MongoDB >= 5.0 for timeseries; mongodb-memory-server defaults to
// 6.0.14 which is fine.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import MongoPagingUpstream from "mongo-cursor-pagination"
import { Db } from "mongodb"
import { connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import DB, { buildFilters } from "@/db"
import { defineModel } from "@/runtime/models"
import { pullChanges } from "@/server/sync"
import { runMutation, mutation, v } from "@/server/handlers"

const MODEL = "ts_sensor_readings"

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()

  defineModel(MODEL, undefined, {
    timeseries: {
      timeField: "ts",
      metaField: "sensorId",
      granularity: "seconds",
    },
  })

  // Allow the onModel listener fire-and-forget to actually finish creating
  // the timeseries collection before tests run.
  await new Promise((r) => setTimeout(r, 200))

  mutation("recordReading", {
    args: v.object({ sensorId: v.string(), value: v.number(), ts: v.number() }),
    handler: async (args, { db }) => {
      return db.model(MODEL).insertOne({
        sensorId: args.sensorId,
        value: args.value,
        ts: new Date(args.ts),
      })
    },
  })
})

afterAll(async () => {
  // Drop the timeseries collection so re-runs of the integration suite start
  // clean — `cleanCollections` would `deleteMany({})` which is restricted on
  // older timeseries versions.
  try {
    await (await connectTestMongo("mogobase_test_integration")).db.dropCollection(MODEL)
  } catch {}
})

beforeEach(async () => {
  // Drop+recreate before each test so insertion order / cursors are
  // deterministic.
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  try { await db.dropCollection(MODEL) } catch {}
  await client.close()
  // Re-apply timeseries definition.
  await (DB as any)._applyModelToDb(DB.db, MODEL, {
    timeseries: { timeField: "ts", metaField: "sensorId", granularity: "seconds" },
  })
})

describe("defineModel with timeseries option", () => {
  it("creates a time-series collection in MongoDB", async () => {
    const { db, client } = await connectTestMongo("mogobase_test_integration")
    const infos = await db.listCollections({ name: MODEL }).toArray()
    expect(infos).toHaveLength(1)
    const info = infos[0] as any
    expect(info.type).toBe("timeseries")
    expect(info.options?.timeseries?.timeField).toBe("ts")
    expect(info.options?.timeseries?.metaField).toBe("sensorId")
    await client.close()
  })
})

describe("autoStamp on timeseries inserts via mutation", () => {
  it("stamps createdAt + updatedAt but not deletedAt", async () => {
    const t0 = Date.now()
    await runMutation(
      "recordReading",
      { sensorId: "s1", value: 21.5, ts: t0 },
      { db: DB }
    )
    const docs = await DB.model(MODEL).find({ sensorId: "s1" }).toArray()
    expect(docs).toHaveLength(1)
    const doc = docs[0] as any
    expect(doc.value).toBe(21.5)
    expect(doc.ts).toBeInstanceOf(Date)
    expect(typeof doc.createdAt).toBe("number")
    expect(typeof doc.updatedAt).toBe("number")
    expect("deletedAt" in doc).toBe(false)
  })
})

describe("buildFilters on timeseries", () => {
  it("filter with metaField and value range works (deletedAt:null matches missing field)", async () => {
    const t0 = Date.now()
    for (let i = 0; i < 5; i++) {
      await runMutation(
        "recordReading",
        { sensorId: "alpha", value: i * 10, ts: t0 + i * 1000 },
        { db: DB }
      )
      await runMutation(
        "recordReading",
        { sensorId: "beta", value: i * 10, ts: t0 + i * 1000 },
        { db: DB }
      )
    }

    const filter = buildFilters({ sensorId: "alpha", value_gte: 20 })
    expect(filter.deletedAt).toBeNull() // buildFilters always injects this
    const docs = await DB.model(MODEL).find(filter).toArray()
    expect(docs).toHaveLength(3)
    for (const d of docs) {
      expect((d as any).sensorId).toBe("alpha")
      expect((d as any).value).toBeGreaterThanOrEqual(20)
    }
  })
})

describe("mongo-cursor-pagination on timeseries", () => {
  it("paginates with limit + next cursor on a timeseries collection", async () => {
    const t0 = Date.now()
    for (let i = 0; i < 10; i++) {
      await runMutation(
        "recordReading",
        { sensorId: "gamma", value: i, ts: t0 + i * 1000 },
        { db: DB }
      )
    }

    const page1 = await (MongoPagingUpstream as any).find(DB.model(MODEL), {
      query: { sensorId: "gamma" },
      limit: 4,
    })
    expect(page1.results).toHaveLength(4)
    expect(page1.hasNext).toBe(true)

    const page2 = await (MongoPagingUpstream as any).find(DB.model(MODEL), {
      query: { sensorId: "gamma" },
      limit: 4,
      next: page1.next,
    })
    expect(page2.results).toHaveLength(4)
    expect(page2.hasNext).toBe(true)

    const page3 = await (MongoPagingUpstream as any).find(DB.model(MODEL), {
      query: { sensorId: "gamma" },
      limit: 4,
      next: page2.next,
    })
    expect(page3.results).toHaveLength(2)
    expect(page3.hasNext).toBe(false)

    // Cursor-stitched results cover all 10, no overlap.
    const seen = new Set([
      ...page1.results.map((r: any) => String(r._id)),
      ...page2.results.map((r: any) => String(r._id)),
      ...page3.results.map((r: any) => String(r._id)),
    ])
    expect(seen.size).toBe(10)
  })
})

describe("sync rejection for timeseries", () => {
  it("pullChanges throws with a clear message on a timeseries model", async () => {
    await expect(
      pullChanges({ model: MODEL, checkpoint: null })
    ).rejects.toThrow(/time-series/i)
  })
})

describe("a lost create race (review round 3)", () => {
  const RACED = "ts_raced"
  // The probe finds nothing; the collection appears before createCollection runs, so
  // createCollection answers NamespaceExists. What appeared decides whether that is fine.
  async function race(winner: "timeseries" | "regular") {
    const db = DB.db
    try { await db.dropCollection(RACED) } catch {}
    const probe = vi.spyOn(db, "listCollections").mockImplementationOnce((() => ({
      toArray: async () => {
        await db.createCollection(RACED, winner === "timeseries" ? { timeseries: { timeField: "ts" } } : {})
        return []
      },
    })) as any)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await (DB as any)._applyModelToDb(db, RACED, { timeseries: { timeField: "ts" } })
      return warn.mock.calls.map((c) => String(c[0]))
    } finally {
      probe.mockRestore()
      warn.mockRestore()
      try { await db.dropCollection(RACED) } catch {}
    }
  }

  it("lost to a concurrent build of the model: silent", async () => {
    expect(await race("timeseries")).toEqual([])
  })

  it("lost to a regular collection: still warns, since MongoDB cannot convert it", async () => {
    expect((await race("regular")).some((m) => /failed to create timeseries collection ts_raced/.test(m))).toBe(true)
  })
})

describe("a build that fails at defineModel is built on first use (review round 4)", () => {
  it("a view's time-series model whose probe failed is created as one by its first use", async () => {
    const DBNAME = "mogobase_test_ts_retry"
    const NAME = "ts_retry"
    const { db: raw, client } = await connectTestMongo(DBNAME)
    await raw.dropDatabase()
    const realList = Db.prototype.listCollections
    let failed = false
    const probe = vi.spyOn(Db.prototype, "listCollections").mockImplementation(function (this: Db, ...a: any[]) {
      if (!failed && this.databaseName === DBNAME) {
        failed = true
        return { toArray: async () => { throw Object.assign(new Error("not primary"), { code: 10107 }) } } as any
      }
      return (realList as any).apply(this, a)
    })
    try {
      await expect(DB.useDatabase(DBNAME).defineModel(NAME, undefined, undefined, { timeField: "ts" })).rejects.toThrow(/not primary/)
    } finally {
      probe.mockRestore()
    }
    // Later uses build again, since the failed build was unmarked (at most once a second while
    // its retry is pending: requests keep coming, as they would).
    await vi.waitFor(
      async () => {
        DB.useDatabase(DBNAME).model(NAME)
        const [found] = await raw.listCollections({ name: NAME }).toArray()
        expect(found?.type).toBe("timeseries")
      },
      { timeout: 4000, interval: 100 }
    )
    await raw.dropDatabase()
    await client.close()
  })
})

describe("the default database: a failed build is built again (review round 7)", () => {
  it("a time-series probe that fails for the cluster's sake is retried, and the collection made a time-series one", async () => {
    const NAME = "ts_default_retry"
    try { await DB.db.dropCollection(NAME) } catch {}
    // On the instance: an earlier test's instance spy, once restored, shadows the prototype.
    const realList = DB.db.listCollections
    let failed = false
    const probe = vi.spyOn(DB.db, "listCollections").mockImplementation(function (this: Db, filter?: any, ...a: any[]) {
      if (!failed && filter?.name === NAME) {
        failed = true
        return { toArray: async () => { throw Object.assign(new Error("not primary"), { code: 10107 }) } } as any
      }
      return (realList as any).call(this, filter, ...a)
    })
    ;(DB as any)._indexRetryDelaysMs = [30]
    try {
      await expect(DB.defineModel(NAME, undefined, undefined, { timeField: "ts" })).rejects.toThrow(/not primary/)
      await vi.waitFor(async () => {
        const [found] = await DB.db.listCollections({ name: NAME }).toArray()
        expect(found?.type).toBe("timeseries")
      })
    } finally {
      probe.mockRestore()
      ;(DB as any)._indexRetryDelaysMs = undefined
      try { await DB.db.dropCollection(NAME) } catch {}
    }
  })

  it("connecting again after disconnect() builds the registered models again", async () => {
    const NAME = "ts_reconnect_rebuilt"
    defineModel(NAME, undefined, { indexSpecs: [{ key: { k: 1 }, name: "k_1" }] })
    await vi.waitFor(async () => expect((await DB.db.collection(NAME).listIndexes().toArray()).map((i) => i.name)).toContain("k_1"))
    await DB.db.dropCollection(NAME) // its indexes are gone…
    await DB.disconnect()
    await DB.connect() // …and come back with the next connection
    await vi.waitFor(async () => expect((await DB.db.collection(NAME).listIndexes().toArray()).map((i) => i.name)).toContain("k_1"))
  })
})
