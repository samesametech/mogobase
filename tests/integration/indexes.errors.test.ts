// A failed index build is reported, and no longer blocks the model's other indexes.
//
// mogobase built a model's indexSpecs in ONE createIndexes call and only console.warned a
// failure. MongoDB fails such a batch as a whole, so one bad spec — here a TTL changed over
// an existing index — left the model without ANY of its declared indexes, including its
// unique one, and nothing but a log line said so.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { Collection } from "mongodb"
import DB, { type IndexErrorEvent } from "@/db"

const DBNAME = "mogobase_test_integration"
const MODEL = "idx_errors"
const indexSpecs = [
  { key: { email: 1 }, name: "email_unique", unique: true },
  { key: { at: 1 }, expireAfterSeconds: 60 },
  { key: { org: 1 } },
]

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = DBNAME
  await DB.connect()
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo(DBNAME)
  try {
    await db.dropCollection(MODEL)
  } catch {}
  await client.close()
  // An older version of the app built this TTL at an hour; the model now says a minute.
  await DB.db.collection(MODEL).createIndex({ at: 1 }, { name: "at_1", expireAfterSeconds: 3600 })
})

describe("index build failures", () => {
  it("build every other spec, report the one that failed, and keep the warning", async () => {
    const events: IndexErrorEvent[] = []
    const off = DB.onIndexError((event) => events.push(event))
    const offThrowing = DB.onIndexError(() => {
      throw new Error("a broken alert hook")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    let warned: any[][] = []
    try {
      await DB.defineModel(MODEL, undefined, { indexSpecs })
    } finally {
      warned = warn.mock.calls.slice()
      off()
      offThrowing()
      warn.mockRestore()
    }

    const names = (await DB.db.collection(MODEL).listIndexes().toArray()).map((i) => i.name).sort()
    expect(names).toEqual([
      "_id_",
      "at_1",
      "email_unique",
      "mogobase_createdAt_1",
      "mogobase_deletedAt_1",
      "mogobase_updatedAt_1",
      "org_1",
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ model: MODEL, dbName: DBNAME, spec: { key: { at: 1 }, expireAfterSeconds: 60 } })
    expect(String((events[0].error as any)?.codeName ?? events[0].error)).toMatch(/IndexOptionsConflict/)
    expect(warned.map((args) => args[0])).toEqual([
      `[mogobase] failed to apply custom indexes for ${MODEL}:`,
      "[mogobase] onIndexError listener threw:",
    ])
  })

  it("after unsubscribing, a listener hears nothing", async () => {
    const events: IndexErrorEvent[] = []
    DB.onIndexError((event) => events.push(event))()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await DB.defineModel(MODEL, undefined, { indexSpecs })
    warn.mockRestore()
    expect(events).toEqual([])
  })

  it("indexReport: declared vs actual for each model, in each database", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await DB.defineModel(MODEL, undefined, { indexSpecs })
    warn.mockRestore()

    const report = await DB.indexReport({ models: [MODEL, "idx_errors_absent"], dbNames: [DBNAME] })
    expect(report.map((r) => [r.model, r.dbName, r.exists])).toEqual([
      [MODEL, DBNAME, true],
      ["idx_errors_absent", DBNAME, false],
    ])
    const mine = report[0]
    expect(mine.conflicting.map((c) => [c.actual.name, c.differs])).toEqual([["at_1", ["expireAfterSeconds"]]])
    expect(mine.missing).toEqual([])
    expect(mine.undeclared).toEqual([])
  })
})

describe("a unique spec over duplicates (scalability review)", () => {
  it("costs the batch and one rebuild of the rest, not a scan per spec", async () => {
    const DUP = "idx_errors_dup"
    try {
      await DB.db.dropCollection(DUP)
    } catch {}
    await DB.db.collection(DUP).insertMany([{ email: "x" }, { email: "x" }])
    const specs = [
      { key: { org: 1 }, name: "org_1" },
      { key: { email: 1 }, name: "email_1", unique: true },
      { key: { at: 1 }, name: "at_1" },
    ]
    const realCreate = Collection.prototype.createIndexes
    const batches: string[][] = []
    const spy = vi.spyOn(Collection.prototype, "createIndexes").mockImplementation(function (this: Collection, s: any[], ...rest: any[]) {
      if (this.collectionName === DUP) batches.push(s.map((spec) => spec.name))
      return (realCreate as any).call(this, s, ...rest)
    })
    const events: IndexErrorEvent[] = []
    const off = DB.onIndexError((e) => events.push(e))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await DB.defineModel(DUP, undefined, { indexSpecs: specs })
    } finally {
      spy.mockRestore()
      off()
      warn.mockRestore()
    }
    expect(batches[0]).toEqual(["org_1", "email_1", "at_1"])
    expect(batches[1]).toEqual(["org_1", "at_1"]) // the rest, together
    expect(batches.filter((b) => b.length === 1 && b[0] === "email_1")).toHaveLength(0) // not tried alone again
    expect(events.map((e) => e.spec.name)).toEqual(["email_1"])
    const names = (await DB.db.collection(DUP).listIndexes().toArray()).map((i) => i.name)
    expect(names).toEqual(expect.arrayContaining(["org_1", "at_1"]))
    expect(names).not.toContain("email_1")
  })
})
