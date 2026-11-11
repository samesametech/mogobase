// The db proxy stamps the CALLER'S document on insert, not only the row it writes.
//
// It used to stamp a copy, so the object a handler passed to insertOne never got
// createdAt/updatedAt — nor the _id the driver assigned, since the driver wrote
// that onto the copy too. A handler that returned or emitted what it had just
// inserted shipped null timestamps, and apps patched every create with a findOne
// of the row they had just written.
//
// These run through a real handler and a real MongoDB, so the driver's own _id
// assignment is in play. The last three pin what must NOT change: the stored row,
// updateOne's stamping, and a sync model's soft delete.

import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { connectTestMongo, getTestMongoUri, cleanCollections } from "../helpers/mongo"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { mutation, runMutation, v } from "@/server/handlers"
import { wrapDbWithAutoStamp } from "@/server/autoStamp"

const PLAIN = "stamp_inplace_plain"
const SYNCED = "stamp_inplace_synced"

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(PLAIN)
  defineModel(SYNCED, undefined, { sync: true })

  // The pattern apps write: build the object, insert it, hand it back.
  mutation("stampInPlace.create", {
    args: v.object({ name: v.string() }),
    handler: async (args, { db }) => {
      const doc: any = { name: args.name }
      const result = await db.model(PLAIN).insertOne(doc)
      return { doc, result }
    },
  })
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [PLAIN, SYNCED])
  await client.close()
})

const stored = (model: string, _id: any) => DB.model(model).findOne({ _id })

describe("insert stamps the caller's own document", () => {
  it("insertOne: the object a handler returns carries the stored stamps and _id", async () => {
    const { doc, result } = await runMutation("stampInPlace.create", { name: "a" }, { db: DB })

    expect(typeof doc.createdAt).toBe("number")
    expect(doc._id).toBeDefined()
    expect(String(doc._id)).toBe(String(result.insertedId))
    const row = await stored(PLAIN, doc._id)
    expect(doc).toEqual(row)
  })

  it("insertOne: keeps the caller's own _id and timestamps", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const doc: any = { _id: "own-1", name: "b", createdAt: 1000 }
    await db.model(PLAIN).insertOne(doc)

    expect(doc._id).toBe("own-1")
    expect(doc.createdAt).toBe(1000)
    expect(typeof doc.updatedAt).toBe("number")
    expect(doc).toEqual(await stored(PLAIN, "own-1"))
  })

  it("insertMany: every caller document gets its stamps and _id", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const docs: any[] = [{ _id: "own-2", name: "c" }, { name: "d" }]
    const result = await db.model(PLAIN).insertMany(docs)

    expect(docs[0]._id).toBe("own-2")
    expect(String(docs[1]._id)).toBe(String(result.insertedIds[1]))
    for (const doc of docs) {
      expect(typeof doc.createdAt).toBe("number")
      expect(doc).toEqual(await stored(PLAIN, doc._id))
    }
  })
})

describe("what stays the same", () => {
  it("the stored row: same fields, same values, stamps ahead of the caller's fields", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const before = Date.now()
    await db.model(PLAIN).insertOne({ _id: "shape-1", name: "e" })
    const row: any = await stored(PLAIN, "shape-1")

    expect(Object.keys(row)).toEqual(["_id", "createdAt", "updatedAt", "deletedAt", "name"])
    expect(row.createdAt).toBeGreaterThanOrEqual(before)
    expect(row.updatedAt).toBe(row.createdAt)
    expect(row.deletedAt).toBeNull()
  })

  it("updateOne stamps updatedAt and leaves createdAt alone", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await db.model(PLAIN).insertOne({ _id: "upd-1", name: "f", createdAt: 1000, updatedAt: 1000 })
    await db.model(PLAIN).updateOne({ _id: "upd-1" }, { $set: { name: "g" } })
    const row: any = await stored(PLAIN, "upd-1")

    expect(row.name).toBe("g")
    expect(row.createdAt).toBe(1000)
    expect(row.updatedAt).toBeGreaterThan(1000)
  })

  it("deleteOne on a sync model still soft-deletes", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await db.model(SYNCED).insertOne({ _id: "del-1", name: "h" })
    await db.model(SYNCED).deleteOne({ _id: "del-1" })
    const row: any = await stored(SYNCED, "del-1")

    expect(row).not.toBeNull()
    expect(typeof row.deletedAt).toBe("number")
    expect(row.updatedAt).toBe(row.deletedAt)
  })
})

describe("re-inserting the same object", () => {
  it("into the same collection twice: two rows, no duplicate key", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const row: any = { name: "template" }
    await db.model(PLAIN).insertOne(row)
    const first = row._id
    await db.model(PLAIN).insertOne(row)
    expect(String(row._id)).not.toBe(String(first))
    expect(await DB.model(PLAIN).countDocuments({ name: "template" })).toBe(2)
  })

  it("copied to a second collection: a fresh _id there, as before the write-back", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const row: any = { name: "copied" }
    await db.model(PLAIN).insertOne(row)
    const first = String(row._id)
    await db.model(SYNCED).insertOne(row)
    expect(String(row._id)).not.toBe(first)
    expect(await DB.model(SYNCED).findOne({ name: "copied" })).toMatchObject({ _id: row._id })
  })
})

describe("re-inserting the same object through bulkWrite (review round 6)", () => {
  it("gets a fresh _id, as through insertOne, not the one written back", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const row: any = { name: "bulk-again" }
    await db.model(PLAIN).insertOne(row)
    await db.model(PLAIN).bulkWrite([{ insertOne: { document: row } }]) // was E11000: the old _id resent
    expect(await DB.model(PLAIN).countDocuments({ name: "bulk-again" })).toBe(2)
  })
})

describe("an inserted object used again in an update or a replacement (review round 11)", () => {
  it("$set with it updates another collection's row without its _id or stamps", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await DB.model(SYNCED).insertOne({ _id: "target" as any, org: "o1", name: "old", createdAt: 1, updatedAt: 1, deletedAt: null })
    const row: any = { org: "o1", name: "new" }
    await db.model(PLAIN).insertOne(row) // row now carries PLAIN's _id and stamps
    await db.model(SYNCED).updateOne({ org: "o1" }, { $set: row }, { upsert: true }) // was: "_id is immutable"
    const target: any = await DB.model(SYNCED).findOne({ _id: "target" as any })
    expect(target.name).toBe("new")
    expect(target.createdAt).toBe(1) // not overwritten with PLAIN's
  })

})

describe("an inserted object used again as a filter or a replacement (review round 12)", () => {
  it("deleteOne(inserted) deletes exactly that row, not another with the same fields", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const twin: any = { name: "Buy milk" }
    const t: any = { name: "Buy milk" }
    await db.model(PLAIN).insertOne(twin)
    await db.model(PLAIN).insertOne(t)
    await db.model(PLAIN).deleteOne(t) // the filter keeps t's _id
    expect(await DB.model(PLAIN).findOne({ _id: twin._id })).not.toBeNull()
    expect(await DB.model(PLAIN).findOne({ _id: t._id })).toBeNull()
  })

  it("replacing a row with its own object keeps its createdAt", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const doc: any = { name: "first" }
    await db.model(PLAIN).insertOne(doc)
    const createdAt = doc.createdAt
    doc.name = "second"
    await db.model(PLAIN).replaceOne({ _id: doc._id }, doc)
    const stored: any = await DB.model(PLAIN).findOne({ _id: doc._id })
    expect(stored.name).toBe("second")
    expect(stored.createdAt).toBe(createdAt)
  })
})
 
describe("an inserted object spread into an update, or used in a bulkWrite update (review round 13)", () => {
  // `{ ...row, extra }` is a new object: the round-11 strip, keyed on the exact object, missed it,
  // and its written-back _id reached $set — "immutable field _id" on another row.
  it("$set with a spread copy updates another collection's row without its _id or stamps", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await DB.model(SYNCED).insertOne({ _id: "target13" as any, org: "o13", name: "old", createdAt: 1, updatedAt: 1, deletedAt: null })
    const row: any = { org: "o13", name: "new" }
    await db.model(PLAIN).insertOne(row)
    await db.model(SYNCED).updateOne({ org: "o13" }, { $set: { ...row, extra: true } })
    const target: any = await DB.model(SYNCED).findOne({ _id: "target13" as any })
    expect(target.name).toBe("new")
    expect(target.extra).toBe(true)
    expect(target.createdAt).toBe(1)
  })

  it("a spread copy keeps the values the caller changed", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await DB.model(SYNCED).insertOne({ _id: "target13b" as any, org: "o13b", createdAt: 1, updatedAt: 1, deletedAt: null })
    const row: any = { org: "o13b" }
    await db.model(PLAIN).insertOne(row)
    await db.model(SYNCED).updateOne({ org: "o13b" }, { $set: { ...row, createdAt: 42 } })
    const target: any = await DB.model(SYNCED).findOne({ _id: "target13b" as any })
    expect(target.createdAt).toBe(42)
  })

  it("bulkWrite updateOne with the inserted object as $set", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await DB.model(SYNCED).insertOne({ _id: "target13c" as any, org: "o13c", name: "old", createdAt: 1, updatedAt: 1, deletedAt: null })
    const row: any = { org: "o13c", name: "new" }
    await db.model(PLAIN).insertOne(row)
    await db.model(SYNCED).bulkWrite([{ updateOne: { filter: { org: "o13c" }, update: { $set: row } } }])
    const target: any = await DB.model(SYNCED).findOne({ _id: "target13c" as any })
    expect(target.name).toBe("new")
    expect(target.createdAt).toBe(1)
  })

  it("bulkWrite updateMany with a spread copy as $set", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await DB.model(SYNCED).insertOne({ _id: "target13d" as any, org: "o13d", name: "old", createdAt: 1, updatedAt: 1, deletedAt: null })
    const row: any = { org: "o13d", name: "new" }
    await db.model(PLAIN).insertOne(row)
    await db.model(SYNCED).bulkWrite([{ updateMany: { filter: { org: "o13d" }, update: { $set: { ...row } } } }])
    const target: any = await DB.model(SYNCED).findOne({ _id: "target13d" as any })
    expect(target.name).toBe("new")
    expect(target.createdAt).toBe(1)
  })

  it("an _id taken on its own is a deliberate reference, and is kept", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const row: any = { org: "o13e" }
    await db.model(PLAIN).insertOne(row)
    await db.model(SYNCED).updateOne({ owner: "o13e" }, { $setOnInsert: { _id: row._id } }, { upsert: true })
    const sidecar: any = await DB.model(SYNCED).findOne({ owner: "o13e" })
    expect(String(sidecar._id)).toBe(String(row._id))
  })
})

describe("restoring a soft-deleted row from the object it was inserted from (review round 14)", () => {
  // The update strip took every value equal to one mogobase wrote back — deletedAt: null too —
  // so a restore written with the object (or a copy of it) left the row deleted, silently.
  it("$set: { ...row, deletedAt: null } restores it", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const row: any = { name: "restore-me" }
    await db.model(SYNCED).insertOne(row)
    await db.model(SYNCED).deleteOne({ _id: row._id }) // a soft delete on a sync model
    expect(((await stored(SYNCED, row._id)) as any).deletedAt).not.toBeNull()
    await db.model(SYNCED).updateOne({ _id: row._id }, { $set: { ...row, deletedAt: null } })
    expect(((await stored(SYNCED, row._id)) as any).deletedAt).toBeNull()
  })

  it("$set: row restores it too: the object says deletedAt is null", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const row: any = { name: "restore-me-too" }
    await db.model(SYNCED).insertOne(row)
    await db.model(SYNCED).deleteOne({ _id: row._id })
    await db.model(SYNCED).updateOne({ _id: row._id }, { $set: row })
    expect(((await stored(SYNCED, row._id)) as any).deletedAt).toBeNull()
  })
})

describe("inserting a spread copy of an inserted object (review round 17)", () => {
  // `{ ...base, name: "b" }` carries the _id and stamps written back onto base; the strip at a
  // re-insert recognised only base itself, so the copy resent base's _id: E11000 here, a reused
  // id (and stale stamps) in another collection — where on main each insert got a fresh _id.
  it("into the same collection: a second row, with a fresh _id", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const base: any = { org: "o17", name: "a" }
    await db.model(PLAIN).insertOne(base)
    const copy: any = { ...base, name: "b" }
    await db.model(PLAIN).insertOne(copy) // was E11000 on _id
    expect(String(copy._id)).not.toBe(String(base._id))
    expect(await DB.model(PLAIN).countDocuments({ org: "o17" })).toBe(2)
  })

  it("through insertMany and bulkWrite too", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const base: any = { org: "o17m", name: "a" }
    await db.model(PLAIN).insertOne(base)
    await db.model(PLAIN).insertMany([{ ...base, name: "b" }])
    await db.model(PLAIN).bulkWrite([{ insertOne: { document: { ...base, name: "c" } } }])
    expect(await DB.model(PLAIN).countDocuments({ org: "o17m" })).toBe(3)
  })

  it("an _id set on its own is the caller's: kept", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const base: any = { org: "o17k" }
    await db.model(PLAIN).insertOne(base)
    const sidecar: any = { _id: base._id, kind: "sidecar" }
    await db.model(SYNCED).insertOne(sidecar)
    expect(String(sidecar._id)).toBe(String(base._id))
  })
})

describe("a deliberate reference that copies a stamp too (review round 19)", () => {
  // `{ _id: row._id, createdAt: row.createdAt }` names its fields one by one: a 1:1 sidecar born
  // with the parent's id and birth time. Taken for a spread copy (an _id plus an unchanged stamp),
  // both were stripped and the sidecar got a fresh id — its joins on _id silently missed.
  it("$setOnInsert: { _id: row._id, createdAt: row.createdAt } keeps both", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const row: any = { org: "o19" }
    await db.model(PLAIN).insertOne(row)
    await db.model(SYNCED).updateOne(
      { parent: "o19" },
      { $setOnInsert: { _id: row._id, createdAt: row.createdAt } },
      { upsert: true }
    )
    const sidecar: any = await DB.model(SYNCED).findOne({ parent: "o19" })
    expect(String(sidecar._id)).toBe(String(row._id))
    expect(sidecar.createdAt).toBe(row.createdAt)
  })
})

describe("writes the wrapper did not stamp (review round F5)", () => {
  // findOneAndReplace fell through to the driver: no updatedAt, so on a sync model the change never
  // passed pullChanges' updatedAt > checkpoint, and no client ever saw it.
  it("findOneAndReplace stamps updatedAt (and keeps the caller's other fields)", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await DB.model(SYNCED).insertOne({ _id: "far1" as any, name: "a", createdAt: 1, updatedAt: 1, deletedAt: null })
    const before = Date.now()
    await db.model(SYNCED).findOneAndReplace({ _id: "far1" }, { name: "b", createdAt: 1, deletedAt: null })
    const row: any = await DB.model(SYNCED).findOne({ _id: "far1" as any })
    expect(row.name).toBe("b")
    expect(row.updatedAt).toBeGreaterThanOrEqual(before)
  })

  // The soft delete matched tombstones too: deleteOne({ listId }) could re-tombstone a row deleted
  // long ago (bumping its updatedAt, re-syncing it everywhere) and leave the live one, and its
  // result had no deletedCount.
  it("a sync model's delete leaves rows already deleted alone, and reports deletedCount", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await DB.model(SYNCED).insertOne({ _id: "sd-old" as any, listId: "L5", createdAt: 1, updatedAt: 1, deletedAt: 5 })
    await DB.model(SYNCED).insertOne({ _id: "sd-live" as any, listId: "L5", createdAt: 1, updatedAt: 1, deletedAt: null })
    const res: any = await db.model(SYNCED).deleteOne({ listId: "L5" })
    expect(res.deletedCount).toBe(1)
    expect(((await DB.model(SYNCED).findOne({ _id: "sd-live" as any })) as any).deletedAt).not.toBeNull()
    expect(((await DB.model(SYNCED).findOne({ _id: "sd-old" as any })) as any).updatedAt).toBe(1) // untouched
    const many: any = await db.model(SYNCED).deleteMany({ listId: "L5" })
    expect(many.deletedCount).toBe(0) // nothing live left
  })
})

describe("a replace keeps the row's engine stamps (review round F8)", () => {
  // A replace stores the replacement: the row's createdAt and deletedAt went with it — screens
  // showed today as its birth, and replacing a tombstoned row brought it back to life on every
  // client. Rounds F5/F7 stamped and then accepted such replacements; they keep both now.
  const seed = (id: string, deletedAt: number | null = null) =>
    DB.model(SYNCED).insertOne({ _id: id as any, name: "a", extra: 1, createdAt: 111, updatedAt: 111, deletedAt })

  it("replaceOne keeps createdAt and deletedAt, replaces the rest, stamps updatedAt", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await seed("rk1")
    await db.model(SYNCED).replaceOne({ _id: "rk1" }, { name: "b" })
    const row: any = await DB.model(SYNCED).findOne({ _id: "rk1" as any })
    expect(row).toMatchObject({ _id: "rk1", name: "b", createdAt: 111, deletedAt: null })
    expect(row.extra).toBeUndefined() // still a replace
    expect(row.updatedAt).toBeGreaterThan(111)
  })

  it("findOneAndReplace too, and returns the replaced row", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await seed("rk2")
    const after: any = await db.model(SYNCED).findOneAndReplace({ _id: "rk2" }, { name: "c" }, { returnDocument: "after" })
    expect(after).toMatchObject({ _id: "rk2", name: "c", createdAt: 111, deletedAt: null })
  })

  it("replacing a tombstoned row keeps its tombstone; a replacement's own stamps win", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await seed("rk3", 222)
    await db.model(SYNCED).replaceOne({ _id: "rk3" }, { name: "d" })
    expect(((await DB.model(SYNCED).findOne({ _id: "rk3" as any })) as any).deletedAt).toBe(222)
    await db.model(SYNCED).replaceOne({ _id: "rk3" }, { name: "e", deletedAt: null, createdAt: 5 })
    expect(await DB.model(SYNCED).findOne({ _id: "rk3" as any })).toMatchObject({ deletedAt: null, createdAt: 5 })
  })

  it("bulkWrite's replaceOne too", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await seed("rk4")
    await db.model(SYNCED).bulkWrite([{ replaceOne: { filter: { _id: "rk4" }, replacement: { name: "f" } } }])
    expect(await DB.model(SYNCED).findOne({ _id: "rk4" as any })).toMatchObject({ name: "f", createdAt: 111, deletedAt: null })
  })
})

describe("an upsert replace keeps a matched row's stamps (review round F9)", () => {
  // An upsert replace stamped createdAt: now and deletedAt: null into the replacement, so one that
  // MATCHED a row overwrote its birth date and cleared its tombstone (on a sync model the row came
  // back on every client). One pipeline now keeps the stored stamps, or stamps birth on an insert.
  it("replaceOne with upsert: a matched tombstoned row keeps createdAt and its tombstone", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await DB.model(SYNCED).insertOne({ _id: "up1" as any, name: "a", createdAt: 111, updatedAt: 111, deletedAt: 222 })
    await db.model(SYNCED).replaceOne({ _id: "up1" }, { name: "b" }, { upsert: true })
    expect(await DB.model(SYNCED).findOne({ _id: "up1" as any })).toMatchObject({ name: "b", createdAt: 111, deletedAt: 222 })
  })

  it("replaceOne with upsert that inserts: birth stamps, and the filter's _id", async () => {
    const db = wrapDbWithAutoStamp(DB)
    const before = Date.now()
    await db.model(SYNCED).replaceOne({ _id: "up2" }, { name: "new" }, { upsert: true })
    const row: any = await DB.model(SYNCED).findOne({ _id: "up2" as any })
    expect(row).toMatchObject({ _id: "up2", name: "new", deletedAt: null })
    expect(row.createdAt).toBeGreaterThanOrEqual(before)
  })

  it("findOneAndReplace and bulkWrite replaceOne with upsert keep a matched row's stamps too", async () => {
    const db = wrapDbWithAutoStamp(DB)
    await DB.model(SYNCED).insertOne({ _id: "up3" as any, name: "a", createdAt: 111, updatedAt: 111, deletedAt: null })
    await DB.model(SYNCED).insertOne({ _id: "up4" as any, name: "a", createdAt: 111, updatedAt: 111, deletedAt: null })
    await db.model(SYNCED).findOneAndReplace({ _id: "up3" }, { name: "c" }, { upsert: true })
    await db.model(SYNCED).bulkWrite([{ replaceOne: { filter: { _id: "up4" }, replacement: { name: "d" }, upsert: true } }])
    expect(await DB.model(SYNCED).findOne({ _id: "up3" as any })).toMatchObject({ name: "c", createdAt: 111 })
    expect(await DB.model(SYNCED).findOne({ _id: "up4" as any })).toMatchObject({ name: "d", createdAt: 111 })
  })
})
