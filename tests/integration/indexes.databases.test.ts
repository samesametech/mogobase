// A model's indexes are built only in the database(s) it lives in.
//
// mogobase applied every model's indexes to the default database at defineModel, and to any
// other database the first time a request touched the model there. In a multi-database app
// (an identity database beside per-mode ones, picked per request) that left an empty "shadow"
// collection, with all its indexes, in every database the model never lives in.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Db, MongoClient } from "mongodb"
import { connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import DB from "@/db"
import { defineModel } from "@/runtime/models"

const DEFAULT = "mogobase_test_integration"
const IDENTITY = "homes_identity"
const LIVE = "homes_mode_live"
const OTHER = "homes_mode_other"
let client: MongoClient

const collections = async (dbName: string) =>
  (await client.db(dbName).listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
const indexNames = async (dbName: string, model: string) =>
  (await client.db(dbName).collection(model).listIndexes().toArray()).map((i) => i.name).sort()
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = DEFAULT
  await DB.connect()
  client = (await connectTestMongo(DEFAULT)).client
  for (const name of [IDENTITY, LIVE, OTHER]) await client.db(name).dropDatabase()
  for (const model of ["homes_members", "homes_payments", "homes_rule_a", "homes_rule_b", "homes_default"]) {
    try {
      await client.db(DEFAULT).dropCollection(model)
    } catch {}
  }
})

afterAll(async () => {
  DB.setModelDatabases(null)
  await client.close()
})

describe("databases", () => {
  it("a list: built in each named database at defineModel, and nowhere else", async () => {
    const indexSpecs = [{ key: { org: 1 }, name: "org_1" }]
    defineModel("homes_members", undefined, { databases: [IDENTITY], indexSpecs })
    await DB.defineModel("homes_members", undefined, { indexSpecs })

    expect(await collections(DEFAULT)).not.toContain("homes_members")
    expect(await indexNames(IDENTITY, "homes_members")).toEqual([
      "_id_",
      "mogobase_createdAt_1",
      "mogobase_deletedAt_1",
      "mogobase_updatedAt_1",
      "org_1",
    ])

    // A request routed to a mode database touches the model there: still nothing is built.
    DB.useDatabase(LIVE).model("homes_members")
    await settle()
    expect(await collections(LIVE)).not.toContain("homes_members")
  })

  it("a predicate: built where it says on first use, and nowhere else", async () => {
    defineModel("homes_payments", undefined, { databases: (db: string) => db.startsWith("homes_mode_") })
    await DB.defineModel("homes_payments")
    expect(await collections(DEFAULT)).not.toContain("homes_payments")

    DB.useDatabase(LIVE).model("homes_payments")
    DB.useDatabase(IDENTITY).model("homes_payments")
    await vi.waitFor(async () => expect(await collections(LIVE)).toContain("homes_payments"))
    await settle()
    expect(await collections(IDENTITY)).not.toContain("homes_payments")
  })

  it("the app-wide rule applies to models with no setting of their own, which win over it", async () => {
    DB.setModelDatabases((model, db) => (model.startsWith("homes_rule_") ? db === OTHER : null))
    defineModel("homes_rule_a")
    defineModel("homes_rule_b", undefined, { databases: [IDENTITY] })
    await DB.defineModel("homes_rule_a")
    await DB.defineModel("homes_rule_b")

    DB.useDatabase(OTHER).model("homes_rule_a")
    DB.useDatabase(LIVE).model("homes_rule_a")
    DB.useDatabase(OTHER).model("homes_rule_b")
    await vi.waitFor(async () => expect(await collections(OTHER)).toContain("homes_rule_a"))
    await settle()
    expect(await collections(DEFAULT)).not.toContain("homes_rule_a")
    expect(await collections(LIVE)).not.toContain("homes_rule_a")
    expect(await collections(OTHER)).not.toContain("homes_rule_b")
    expect(await collections(IDENTITY)).toContain("homes_rule_b")
    DB.setModelDatabases(null)
  })

  it("unset: the default database at defineModel and any other on first use, as before", async () => {
    defineModel("homes_default")
    await DB.defineModel("homes_default")
    expect(await collections(DEFAULT)).toContain("homes_default")
    DB.useDatabase(OTHER).model("homes_default")
    await vi.waitFor(async () => expect(await collections(OTHER)).toContain("homes_default"))
  })

  it("in a database the model does not live in, every index there is undeclared", async () => {
    // A shadow an older version left behind.
    await client.db(LIVE).collection("homes_members").createIndex({ org: 1 }, { name: "org_1" })
    const diff = await DB.diffIndexes("homes_members", { dbName: LIVE })
    expect(diff.declared).toEqual([])
    expect(diff.undeclared.map((i) => i.name)).toEqual(["org_1"])
    expect((await DB.diffIndexes("homes_members", { dbName: IDENTITY })).undeclared).toEqual([])
  })
})

describe("databases: several at once, and the report", () => {
  it("a list of several databases builds in every one by the time defineModel resolves", async () => {
    defineModel("homes_multi", undefined, { databases: [LIVE, OTHER, IDENTITY] })
    await DB.defineModel("homes_multi")
    for (const dbName of [LIVE, OTHER, IDENTITY]) expect(await collections(dbName)).toContain("homes_multi")
    expect(await collections(DEFAULT)).not.toContain("homes_multi")
  })

  it("indexReport covers every database a model was built in, and only those", async () => {
    const report = await DB.indexReport({ models: ["homes_members", "homes_multi"] })
    const where = (model: string) => report.filter((r) => r.model === model).map((r) => r.dbName).sort()
    expect(where("homes_members")).toEqual([IDENTITY])
    expect(where("homes_multi")).toEqual([IDENTITY, LIVE, OTHER].sort())
  })
})

describe("databases: races and the report (review round 1)", () => {
  it("a request touching a model while defineModel builds it does not start a second build", async () => {
    const created: string[] = []
    const realCreate = Db.prototype.createCollection
    const spy = vi.spyOn(Db.prototype, "createCollection").mockImplementation(function (this: Db, ...a: any[]) {
      created.push(`${this.databaseName}.${a[0]}`)
      return (realCreate as any).apply(this, a)
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      // The registry's listener starts DB.defineModel synchronously…
      defineModel("homes_ts_race", undefined, { timeseries: { timeField: "at" }, databases: [OTHER] })
      // …and a request reaches the model in that database before the build is awaited.
      DB.useDatabase(OTHER).model("homes_ts_race")
      await vi.waitFor(async () => expect(await collections(OTHER)).toContain("homes_ts_race"))
      await settle()
      expect(created.filter((c) => c === `${OTHER}.homes_ts_race`)).toHaveLength(1)
      expect(warn.mock.calls.some(([msg]) => String(msg).includes("failed to create timeseries collection"))).toBe(false)
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })

  it("indexReport on a view covers the view's database only", async () => {
    const report = await DB.useDatabase(IDENTITY).indexReport({ models: ["homes_members", "homes_multi"] })
    expect([...new Set(report.map((r) => r.dbName))]).toEqual([IDENTITY])
  })

  it("indexReport lists in parallel, and keeps its order", async () => {
    let inFlight = 0
    let most = 0
    const real = (DB as any)._diffIndexes.bind(DB)
    const spy = vi.spyOn(DB as any, "_diffIndexes").mockImplementation(async (...a: any[]) => {
      inFlight++
      most = Math.max(most, inFlight)
      try {
        return await real(...a)
      } finally {
        inFlight--
      }
    })
    try {
      const models = ["homes_multi", "homes_default"]
      const dbNames = [LIVE, OTHER, IDENTITY]
      const report = await DB.indexReport({ models, dbNames })
      expect(most).toBeGreaterThan(1)
      const expected = dbNames.flatMap((db) => models.filter((m) => DB.livesIn(m, db)).map((m) => `${db}/${m}`))
      expect(report.map((r) => `${r.dbName}/${r.model}`)).toEqual(expected)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("view index helpers with an explicit undefined (review round 2)", () => {
  it("dbName: undefined on a view still means the view's database, never the default", async () => {
    await client.db(OTHER).collection("homes_view_drop").createIndex({ stray: 1 }, { name: "stray_1" })
    await client.db(DEFAULT).collection("homes_view_drop").createIndex({ keepMe: 1 }, { name: "keep_me_1" })
    const view = DB.useDatabase(OTHER)
    const dry = await view.dropUndeclaredIndexes("homes_view_drop", { dbName: undefined, dryRun: true })
    expect(dry.dbName).toBe(OTHER)
    expect((await view.diffIndexes("homes_view_drop", { dbName: undefined })).dbName).toBe(OTHER)
    expect([...new Set((await view.indexReport({ dbNames: undefined, models: ["homes_view_drop"] })).map((r) => r.dbName))]).toEqual([OTHER])
    await view.dropUndeclaredIndexes("homes_view_drop", { dbName: undefined })
    expect(await indexNames(DEFAULT, "homes_view_drop")).toContain("keep_me_1")
  })
})

describe("databases (review round 2)", () => {
  it("defineModel on a view builds the model's other listed databases too", async () => {
    const A = "homes_view_list_a"
    const B = "homes_view_list_b"
    for (const name of [A, B]) await client.db(name).dropDatabase()
    defineModel("homes_view_listed", undefined, { databases: [A, B] }) // the singleton builds both…
    await vi.waitFor(async () => expect(await collections(B)).toContain("homes_view_listed"))
    await client.db(B).dropDatabase() // …B is lost…
    await DB.useDatabase(A).defineModel("homes_view_listed") // …and a view's defineModel builds it again
    expect(await collections(A)).toContain("homes_view_listed")
    expect(await collections(B)).toContain("homes_view_listed")
  })

  it("diffIndexes and indexReport connect first, as defineModel does", async () => {
    await DB.disconnect()
    const diff = await DB.diffIndexes("homes_members", { dbName: IDENTITY })
    expect(diff.dbName).toBe(IDENTITY)
    await DB.disconnect()
    const report = await DB.indexReport({ models: ["homes_members"], dbNames: [IDENTITY] })
    expect(report).toHaveLength(1)
  })
})

describe("dropping in a database the model does not live in (review round 3)", () => {
  it("is refused unless shadow: true; a dry run is always allowed", async () => {
    // homes_members lives in IDENTITY only. Something else keeps a collection of that name in
    // OTHER, with a unique index of its own.
    await client.db(OTHER).collection("homes_members").createIndex({ email: 1 }, { name: "email_1", unique: true })

    const dry = await DB.dropUndeclaredIndexes("homes_members", { dbName: OTHER, dryRun: true })
    expect(dry.dropped).toEqual(["email_1"])
    await expect(DB.dropUndeclaredIndexes("homes_members", { dbName: OTHER })).rejects.toThrow(/does not live in "homes_mode_other"/)
    await expect(DB.useDatabase(OTHER).dropUndeclaredIndexes("homes_members")).rejects.toThrow(/shadow: true/)
    expect(await indexNames(OTHER, "homes_members")).toEqual(["_id_", "email_1"])

    const done = await DB.dropUndeclaredIndexes("homes_members", { dbName: OTHER, shadow: true })
    expect(done.dropped).toEqual(["email_1"])
    expect(await indexNames(OTHER, "homes_members")).toEqual(["_id_"])
  })
})

describe("indexReport and listed databases (review round 7)", () => {
  it("lists each database's collections once, not once per model", async () => {
    const realList = Db.prototype.listCollections
    const listed: string[] = []
    const spy = vi.spyOn(Db.prototype, "listCollections").mockImplementation(function (this: Db, ...a: any[]) {
      listed.push(this.databaseName)
      return (realList as any).apply(this, a)
    })
    try {
      await DB.indexReport({ models: ["homes_multi", "homes_default", "homes_members"], dbNames: [LIVE, IDENTITY] })
    } finally {
      spy.mockRestore()
    }
    expect(listed.sort()).toEqual([IDENTITY, LIVE])
  })

  it("a listed database whose build fails does not fail defineModel where it was asked", async () => {
    const A = "homes_listed_ok"
    const B = "homes_listed_fails"
    for (const name of [A, B]) await client.db(name).dropDatabase()
    defineModel("homes_listed_ts", undefined, { databases: [A, B], timeseries: { timeField: "ts" } })
    await vi.waitFor(async () => expect(await collections(B)).toContain("homes_listed_ts")) // the runtime registration's build
    await client.db(B).dropDatabase()
    const realList = Db.prototype.listCollections
    const probe = vi.spyOn(Db.prototype, "listCollections").mockImplementation(function (this: Db, ...a: any[]) {
      if (this.databaseName === B) return { toArray: async () => { throw new Error("probe refused") } } as any
      return (realList as any).apply(this, a)
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(DB.useDatabase(A).defineModel("homes_listed_ts", undefined, undefined, { timeField: "ts" })).resolves.toBeTruthy()
    } finally {
      probe.mockRestore()
      warn.mockRestore()
    }
  })
})

describe("defineModel's handle (review round 12)", () => {
  it("is on a database the model lives in, not on the default one", async () => {
    const coll = await DB.defineModel("homes_members", undefined, { indexSpecs: [{ key: { org: 1 }, name: "org_1" }] })
    expect(coll.dbName).toBe(IDENTITY)
  })
})
