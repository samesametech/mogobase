// Stamp-index opt-out, and the explicit drop of indexes a model no longer declares.
//
// mogobase built createdAt/updatedAt/deletedAt indexes on every collection and never
// dropped an index it had built — so a large collection carried three indexes none of its
// queries used, plus every index a model had since stopped declaring.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Collection } from "mongodb"
import { connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import DB from "@/db"
import { defineModel } from "@/runtime/models"

const DBNAME = "mogobase_test_integration"
const names = async (model: string) =>
  (await DB.db.collection(model).listIndexes().toArray()).map((i) => i.name).sort()

const reset = async (models: string[]) => {
  const { db, client } = await connectTestMongo(DBNAME)
  for (const m of models) {
    try {
      await db.dropCollection(m)
    } catch {}
  }
  await client.close()
}

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = DBNAME
  await DB.connect()
})

describe("stampIndexes", () => {
  beforeEach(() => reset(["idx_stamp_default", "idx_stamp_partial", "idx_stamp_none"]))

  it("builds all three by default, only the kept ones when told, and none on false", async () => {
    defineModel("idx_stamp_default")
    defineModel("idx_stamp_partial", undefined, { stampIndexes: { createdAt: false } })
    defineModel("idx_stamp_none", undefined, { stampIndexes: false, indexSpecs: [{ key: { org: 1 }, name: "org_1" }] })
    await DB.defineModel("idx_stamp_default")
    await DB.defineModel("idx_stamp_partial")
    await DB.defineModel("idx_stamp_none", undefined, { indexSpecs: [{ key: { org: 1 }, name: "org_1" }] })

    expect(await names("idx_stamp_default")).toEqual([
      "_id_",
      "mogobase_createdAt_1",
      "mogobase_deletedAt_1",
      "mogobase_updatedAt_1",
    ])
    expect(await names("idx_stamp_partial")).toEqual(["_id_", "mogobase_deletedAt_1", "mogobase_updatedAt_1"])
    expect(await names("idx_stamp_none")).toEqual(["_id_", "org_1"])
  })
})

describe("diffIndexes / dropUndeclaredIndexes", () => {
  const MODEL = "idx_drop"
  beforeEach(async () => {
    await reset([MODEL])
    // Built by an older version of the app: the createdAt stamp it has since opted out of,
    // an index it no longer declares, a non-unique email index it has since made unique,
    // and one created by hand that the app wants kept.
    const col = DB.db.collection(MODEL)
    await col.createIndex({ createdAt: 1 }, { name: "mogobase_createdAt_1" })
    await col.createIndex({ legacy: 1 }, { name: "legacy_1" })
    await col.createIndex({ handMade: 1 }, { name: "hand_made_1" })
    await col.createIndex({ email: 1 }, { name: "email_1" })
    const indexSpecs = [{ key: { email: 1 }, name: "email_unique", unique: true }]
    defineModel(MODEL, undefined, { stampIndexes: { createdAt: false }, indexSpecs })
    await DB.defineModel(MODEL, undefined, { indexSpecs })
  })

  it("lists undeclared indexes, read-only", async () => {
    const diff = await DB.diffIndexes(MODEL)
    expect(diff.dbName).toBe(DBNAME)
    // MongoDB built the unique email index beside the old one, which nothing declares now.
    expect(diff.undeclared.map((i) => i.name).sort()).toEqual(["email_1", "hand_made_1", "legacy_1", "mogobase_createdAt_1"])
    expect(diff.conflicting).toEqual([])
    expect(diff.missing).toEqual([])
  })

  it("dry run lists, the real run drops, sparing `keep`", async () => {
    const dry = await DB.dropUndeclaredIndexes(MODEL, { dryRun: true, keep: ["hand_made_1"] })
    expect(dry.dropped.sort()).toEqual(["email_1", "legacy_1", "mogobase_createdAt_1"])
    expect(await names(MODEL)).toContain("legacy_1")

    const done = await DB.dropUndeclaredIndexes(MODEL, { keep: ["hand_made_1"] })
    expect(done.dropped.sort()).toEqual(["email_1", "legacy_1", "mogobase_createdAt_1"])
    expect(await names(MODEL)).toEqual(["_id_", "email_unique", "hand_made_1", "mogobase_deletedAt_1", "mogobase_updatedAt_1"])

    expect((await DB.dropUndeclaredIndexes(MODEL, { keep: ["hand_made_1"] })).dropped).toEqual([])
  })

  it("a collection that does not exist yet has everything missing and nothing to drop", async () => {
    const diff = await DB.diffIndexes("idx_never_created")
    expect(diff.actual).toEqual([])
    expect(diff.missing.length).toBeGreaterThan(0)
    expect((await DB.dropUndeclaredIndexes("idx_never_created")).dropped).toEqual([])
  })
})

describe("diffIndexes against what MongoDB actually lists", () => {
  const MODEL = "idx_real_shapes"
  beforeEach(() => reset([MODEL]))

  it("a Map key, a collation and a text index all match what was built — nothing is dropped", async () => {
    const indexSpecs: any[] = [
      { key: new Map([["org", 1], ["at", -1]]), name: "org_at" },
      { key: { name: 1 }, name: "name_ci", collation: { locale: "en", strength: 2 } },
      { key: { title: "text", body: "text" }, name: "search" },
    ]
    defineModel(MODEL, undefined, { indexSpecs })
    await DB.defineModel(MODEL, undefined, { indexSpecs })
    const diff = await DB.diffIndexes(MODEL)
    expect(diff.missing).toEqual([])
    expect(diff.conflicting).toEqual([])
    expect(diff.undeclared).toEqual([])
    expect((await DB.dropUndeclaredIndexes(MODEL)).dropped).toEqual([])
  })

  it("a plain index beside the declared collated one is the undeclared one", async () => {
    // A model of its own: the registry is global, and since definitions' index specs add up
    // (review round F14) the test above's specs would be declared here too.
    const PLAIN = "idx_real_shapes_plain"
    await reset([PLAIN])
    await DB.db.collection(PLAIN).createIndex({ name: 1 }, { name: "name_1" })
    const indexSpecs: any[] = [{ key: { name: 1 }, name: "name_ci", collation: { locale: "en", strength: 2 } }]
    defineModel(PLAIN, undefined, { indexSpecs })
    await DB.defineModel(PLAIN, undefined, { indexSpecs })
    const diff = await DB.diffIndexes(PLAIN)
    expect(diff.conflicting).toEqual([])
    expect(diff.undeclared.map((i) => i.name)).toEqual(["name_1"])
  })
})

describe("diffIndexes and dropUndeclaredIndexes (review round 6)", () => {
  beforeEach(() => reset(["idx_collated", "idx_drop_partial"]))

  it("an index declared without a collation, on a collection with a default one, is not conflicting", async () => {
    await DB.db.createCollection("idx_collated", { collation: { locale: "en", strength: 2 } })
    defineModel("idx_collated", undefined, { stampIndexes: false, indexSpecs: [{ key: { email: 1 }, name: "email_1", unique: true }] })
    await DB.defineModel("idx_collated", undefined, { indexSpecs: [{ key: { email: 1 }, name: "email_1", unique: true }] })
    const diff = await DB.diffIndexes("idx_collated")
    expect(diff.missing).toEqual([])
    expect(diff.conflicting).toEqual([])
  })

  it("a drop that fails part-way tries the rest, and says what it dropped", async () => {
    defineModel("idx_drop_partial", undefined, { stampIndexes: false })
    await DB.defineModel("idx_drop_partial")
    for (const f of ["a", "b", "c"]) await DB.db.collection("idx_drop_partial").createIndex({ [f]: 1 }, { name: `${f}_1` })
    const realDrop = Collection.prototype.dropIndex
    const spy = vi.spyOn(Collection.prototype, "dropIndex").mockImplementation(function (this: Collection, name: any, ...rest: any[]) {
      if (name === "b_1") return Promise.reject(Object.assign(new Error("index build in progress"), { code: 12587 }))
      return (realDrop as any).call(this, name, ...rest)
    })
    let error: any
    try {
      await DB.dropUndeclaredIndexes("idx_drop_partial")
    } catch (e) {
      error = e
    } finally {
      spy.mockRestore()
    }
    expect(error?.message).toMatch(/could not drop b_1; dropped a_1, c_1/)
    expect(error.dropped).toEqual(["a_1", "c_1"])
    expect(await names("idx_drop_partial")).toEqual(["_id_", "b_1"])
  })

  it("an index another process dropped meanwhile is not a failure", async () => {
    defineModel("idx_drop_partial", undefined, { stampIndexes: false })
    await DB.defineModel("idx_drop_partial")
    await DB.db.collection("idx_drop_partial").createIndex({ a: 1 }, { name: "a_1" })
    const realDrop = Collection.prototype.dropIndex
    const spy = vi.spyOn(Collection.prototype, "dropIndex").mockImplementation(function (this: Collection, ...a: any[]) {
      return (realDrop as any).apply(this, a).then(() => (realDrop as any).apply(this, a)) // the second call finds it gone
    })
    try {
      await expect(DB.dropUndeclaredIndexes("idx_drop_partial")).resolves.toMatchObject({ dropped: [] })
    } finally {
      spy.mockRestore()
    }
  })
})
