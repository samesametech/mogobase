// tests/unit/server/autoStamp.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import z4 from "zod/v4"
import { wrapDbWithAutoStamp } from "@/server/autoStamp"
import { defineModel } from "@/runtime/models"

// Build a fake db that mirrors the shape used by handler ctx.db.
// db.model(name) returns a fake collection with the mutation methods we
// care about, each one a vi.fn so we can inspect what was passed through.
function makeFakeDb() {
  const calls: { method: string; args: any[] }[] = []
  const make = (method: string) => vi.fn((...args: any[]) => {
    calls.push({ method, args })
    return Promise.resolve({ acknowledged: true, insertedId: "x" })
  })
  const collection = {
    insertOne: make("insertOne"),
    insertMany: make("insertMany"),
    updateOne: make("updateOne"),
    updateMany: make("updateMany"),
    deleteOne: make("deleteOne"),
    deleteMany: make("deleteMany"),
    findOne: make("findOne"),
    find: make("find"),
    findOneAndUpdate: make("findOneAndUpdate"),
    replaceOne: make("replaceOne"),
    bulkWrite: make("bulkWrite"),
  } as any
  return {
    model: vi.fn(() => collection),
    calls,
    collection,
  }
}

describe("wrapDbWithAutoStamp", () => {
  let now: number
  beforeEach(() => {
    now = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(now)
  })

  it("stamps createdAt + updatedAt + deletedAt:null on insertOne", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").insertOne({ name: "a" })
    expect(db.collection.insertOne).toHaveBeenCalledTimes(1)
    const inserted = db.collection.insertOne.mock.calls[0][0]
    expect(inserted.name).toBe("a")
    expect(inserted.createdAt).toBe(now)
    expect(inserted.updatedAt).toBe(now)
    expect(inserted.deletedAt).toBeNull()
  })

  it("stamps each row on insertMany", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").insertMany([{ name: "a" }, { name: "b" }])
    const inserted = db.collection.insertMany.mock.calls[0][0]
    expect(inserted).toHaveLength(2)
    for (const row of inserted) {
      expect(row.createdAt).toBe(now)
      expect(row.updatedAt).toBe(now)
      expect(row.deletedAt).toBeNull()
    }
  })

  it("stamps updatedAt on updateOne with $set", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").updateOne({ _id: "x" }, { $set: { name: "b" } })
    const update = db.collection.updateOne.mock.calls[0][1]
    expect(update.$set.name).toBe("b")
    expect(update.$set.updatedAt).toBe(now)
  })

  it("stamps updatedAt on updateMany", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").updateMany({ active: true }, { $set: { tag: "t" } })
    const update = db.collection.updateMany.mock.calls[0][1]
    expect(update.$set.updatedAt).toBe(now)
  })

  it("passes deleteOne through unchanged for non-sync models", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").deleteOne({ _id: "x" })
    expect(db.collection.deleteOne).toHaveBeenCalledTimes(1)
    expect(db.collection.deleteOne).toHaveBeenCalledWith({ _id: "x" })
    expect(db.collection.updateOne).not.toHaveBeenCalled()
  })

  it("passes deleteMany through unchanged for non-sync models", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").deleteMany({ active: false })
    expect(db.collection.deleteMany).toHaveBeenCalledTimes(1)
    expect(db.collection.deleteMany).toHaveBeenCalledWith({ active: false })
    expect(db.collection.updateMany).not.toHaveBeenCalled()
  })

  it("rewrites deleteOne into soft-delete updateOne when sync is enabled", async () => {
    defineModel("syncedWidgets", undefined, { sync: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("syncedWidgets").deleteOne({ _id: "x" })
    expect(db.collection.deleteOne).not.toHaveBeenCalled()
    expect(db.collection.updateOne).toHaveBeenCalledTimes(1)
    const update = db.collection.updateOne.mock.calls[0][1]
    expect(update.$set.deletedAt).toBe(now)
    expect(update.$set.updatedAt).toBe(now)
  })

  it("rewrites deleteMany into soft-delete updateMany when sync is enabled", async () => {
    defineModel("syncedWidgets", undefined, { sync: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("syncedWidgets").deleteMany({ active: false })
    expect(db.collection.deleteMany).not.toHaveBeenCalled()
    expect(db.collection.updateMany).toHaveBeenCalledTimes(1)
    const update = db.collection.updateMany.mock.calls[0][1]
    expect(update.$set.deletedAt).toBe(now)
    expect(update.$set.updatedAt).toBe(now)
  })

  it("passes findOne / find through unchanged", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").findOne({ _id: "x" })
    expect(db.collection.findOne).toHaveBeenCalledWith({ _id: "x" })
  })

  // ——— The caller's own document. The wrapper stores a stamped COPY, so the
  // object a handler built and passed in used to keep no stamps and no _id, and
  // every handler returning what it had just inserted shipped null timestamps.

  it("insertOne writes the stored stamps and generated _id back onto the caller's object", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    const doc: any = { name: "a" }
    await wrapped.model("widgets").insertOne(doc)
    const stored = db.collection.insertOne.mock.calls[0][0]
    expect(stored).not.toBe(doc)
    expect(doc).toEqual({ name: "a", createdAt: now, updatedAt: now, deletedAt: null, _id: "x" })
    // The stored copy is shaped as it always was: stamps first, no _id of ours.
    expect(Object.keys(stored)).toEqual(["createdAt", "updatedAt", "deletedAt", "name"])
  })

  it("insertOne keeps a caller's own _id and timestamps", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    const doc: any = { _id: "mine", createdAt: 42 }
    await wrapped.model("widgets").insertOne(doc)
    expect(doc).toEqual({ _id: "mine", createdAt: 42, updatedAt: now, deletedAt: null })
  })

  it("insertMany writes back each row, with its _id by position", async () => {
    const db = makeFakeDb()
    db.collection.insertMany.mockResolvedValueOnce({ acknowledged: true, insertedIds: { 0: "own", 1: "gen" } })
    const wrapped = wrapDbWithAutoStamp(db as any)
    const docs: any[] = [{ _id: "own", name: "a" }, { name: "b" }]
    await wrapped.model("widgets").insertMany(docs)
    expect(docs[0]).toEqual({ _id: "own", name: "a", createdAt: now, updatedAt: now, deletedAt: null })
    expect(docs[1]).toEqual({ _id: "gen", name: "b", createdAt: now, updatedAt: now, deletedAt: null })
  })

  it("a failed insert leaves the caller's object as it was", async () => {
    const db = makeFakeDb()
    db.collection.insertOne.mockRejectedValueOnce(new Error("E11000 duplicate key"))
    const wrapped = wrapDbWithAutoStamp(db as any)
    const doc: any = { name: "a" }
    await expect(wrapped.model("widgets").insertOne(doc)).rejects.toThrow(/duplicate/)
    expect(doc).toEqual({ name: "a" })
  })

  it("a frozen document still inserts, stamped in storage only", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    const doc = Object.freeze({ name: "a" })
    await expect(wrapped.model("widgets").insertOne(doc)).resolves.toBeDefined()
    expect(db.collection.insertOne.mock.calls[0][0].createdAt).toBe(now)
    expect(doc).toEqual({ name: "a" })
  })

  // Re-inserting the same object: what mogobase wrote onto it is not the caller's own, so the
  // second insert gets a fresh _id and fresh stamps — as every insert did before the write-back.
  it("re-inserting the same object sends a fresh _id and fresh stamps, not the first insert's", async () => {
    const db = makeFakeDb()
    db.collection.insertOne
      .mockResolvedValueOnce({ acknowledged: true, insertedId: "id1" })
      .mockResolvedValueOnce({ acknowledged: true, insertedId: "id2" })
    const wrapped = wrapDbWithAutoStamp(db as any)
    const row: any = { name: "a" }
    await wrapped.model("widgets").insertOne(row)
    vi.spyOn(Date, "now").mockReturnValue(now + 1000)
    row.n = 2
    await wrapped.model("widgets").insertOne(row)

    const second = db.collection.insertOne.mock.calls[1][0]
    expect("_id" in second).toBe(false)
    expect(second).toEqual({ createdAt: now + 1000, updatedAt: now + 1000, deletedAt: null, name: "a", n: 2 })
    expect(row).toMatchObject({ _id: "id2", createdAt: now + 1000, updatedAt: now + 1000 })
  })

  it("a value the caller sets after an insert is the caller's, and is kept", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    const row: any = { name: "a" }
    await wrapped.model("widgets").insertOne(row)
    row._id = "mine"
    row.createdAt = 5
    await wrapped.model("widgets").insertOne(row)
    expect(db.collection.insertOne.mock.calls[1][0]).toMatchObject({ _id: "mine", createdAt: 5 })
    expect(row).toMatchObject({ _id: "mine", createdAt: 5 })
  })
})

describe("wrapDbWithAutoStamp + dbValidation", () => {
  // Each test uses a unique model name so registry state from earlier tests
  // (or other suites) can't satisfy/contaminate this one.
  const validatedSchema = {
    name: z4.string(),
    qty: z4.number(),
    userId: z4.string(),
  }

  it("does NOT validate when dbValidation is unset", async () => {
    defineModel("dbVal_off", validatedSchema as any)
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    // Wrong types — would fail validation if it were on. Should pass through.
    await expect(
      wrapped.model("dbVal_off").insertOne({ name: 123, qty: "nope", userId: 9 } as any)
    ).resolves.toBeDefined()
    expect(db.collection.insertOne).toHaveBeenCalledTimes(1)
  })

  it("insertOne accepts a valid doc", async () => {
    defineModel("dbVal_insertValid", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(
      wrapped.model("dbVal_insertValid").insertOne({ name: "a", qty: 3, userId: "u1" })
    ).resolves.toBeDefined()
    expect(db.collection.insertOne).toHaveBeenCalledTimes(1)
  })

  it("insertOne rejects on type mismatch", async () => {
    defineModel("dbVal_insertBadType", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(async () => {
      await wrapped.model("dbVal_insertBadType").insertOne({ name: "a", qty: "three", userId: "u1" } as any)
    }).rejects.toThrow(/Validation failed for dbVal_insertBadType\.insertOne/)
    expect(db.collection.insertOne).not.toHaveBeenCalled()
  })

  it("insertOne rejects on missing required field", async () => {
    defineModel("dbVal_insertMissing", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(async () => {
      await wrapped.model("dbVal_insertMissing").insertOne({ name: "a", qty: 3 } as any)
    }).rejects.toThrow(/userId/)
    expect(db.collection.insertOne).not.toHaveBeenCalled()
  })

  it("insertMany rejects the whole batch on first bad row", async () => {
    defineModel("dbVal_insertManyBad", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(async () => {
      await wrapped.model("dbVal_insertManyBad").insertMany([
        { name: "a", qty: 1, userId: "u1" },
        { name: "b", qty: "bad", userId: "u1" } as any,
      ])
    }).rejects.toThrow(/Validation failed/)
    expect(db.collection.insertMany).not.toHaveBeenCalled()
  })

  it("updateOne $set is validated as a partial", async () => {
    defineModel("dbVal_update", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    // Valid partial — only one field present, others not required because partial.
    await expect(
      wrapped.model("dbVal_update").updateOne({ _id: "x" }, { $set: { qty: 7 } })
    ).resolves.toBeDefined()
    expect(db.collection.updateOne).toHaveBeenCalledTimes(1)
  })

  it("updateOne rejects bad $set value", async () => {
    defineModel("dbVal_updateBad", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(async () => {
      await wrapped.model("dbVal_updateBad").updateOne({ _id: "x" }, { $set: { qty: "nope" } } as any)
    }).rejects.toThrow(/Validation failed for dbVal_updateBad\.updateOne/)
    expect(db.collection.updateOne).not.toHaveBeenCalled()
  })

  it("updateMany rejects bad $set value", async () => {
    defineModel("dbVal_updateMany", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(async () => {
      await wrapped.model("dbVal_updateMany").updateMany({ active: true }, { $set: { name: 5 } } as any)
    }).rejects.toThrow(/Validation failed for dbVal_updateMany\.updateMany/)
    expect(db.collection.updateMany).not.toHaveBeenCalled()
  })

  it("updateOne $setOnInsert is validated as a partial", async () => {
    defineModel("dbVal_upsert", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(async () => {
      await wrapped.model("dbVal_upsert").updateOne(
        { _id: "x" },
        { $setOnInsert: { qty: false } } as any,
      )
    }).rejects.toThrow(/Validation failed/)
    expect(db.collection.updateOne).not.toHaveBeenCalled()
  })

  it("aggregation-pipeline updates skip validation", async () => {
    defineModel("dbVal_pipeline", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    // The pipeline carries a value that would fail the partial schema, but
    // pipelines are too dynamic to statically check — the wrapper lets it through.
    await expect(
      wrapped.model("dbVal_pipeline").updateOne(
        { _id: "x" },
        [{ $set: { qty: "still goes through" } }] as any,
      )
    ).resolves.toBeDefined()
    expect(db.collection.updateOne).toHaveBeenCalledTimes(1)
  })

  it("full-replace update validates the whole doc", async () => {
    defineModel("dbVal_replace", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(async () => {
      await wrapped.model("dbVal_replace").updateOne(
        { _id: "x" },
        { name: "a", qty: "bad", userId: "u1" } as any,
      )
    }).rejects.toThrow(/Validation failed/)
    expect(db.collection.updateOne).not.toHaveBeenCalled()
  })

  it("findOneAndUpdate honors validation", async () => {
    defineModel("dbVal_findUpdate", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(async () => {
      await wrapped.model("dbVal_findUpdate").findOneAndUpdate(
        { _id: "x" },
        { $set: { qty: false } } as any,
      )
    }).rejects.toThrow(/Validation failed for dbVal_findUpdate\.findOneAndUpdate/)
    expect(db.collection.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it("schemaless model with dbValidation only validates engine fields", async () => {
    // No consumer schema — withSyncFields produces just createdAt/updatedAt/deletedAt.
    // autoStamp injects all three before validation, so any payload should pass.
    defineModel("dbVal_schemaless", undefined, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(
      wrapped.model("dbVal_schemaless").insertOne({ anything: 1 })
    ).resolves.toBeDefined()
    expect(db.collection.insertOne).toHaveBeenCalledTimes(1)
  })

  it("works with a ZodObject schema (not just plain shape)", async () => {
    const zodSchema = z4.object({
      name: z4.string(),
      qty: z4.number(),
    })
    defineModel("dbVal_zodObject", zodSchema, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await expect(async () => {
      await wrapped.model("dbVal_zodObject").insertOne({ name: "a", qty: "bad" } as any)
    }).rejects.toThrow(/Validation failed/)
    expect(db.collection.insertOne).not.toHaveBeenCalled()
  })

  it("findOne / find still pass through when dbValidation is on", async () => {
    defineModel("dbVal_reads", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("dbVal_reads").findOne({ _id: "x" })
    expect(db.collection.findOne).toHaveBeenCalledWith({ _id: "x" })
  })

  it("a refused insert leaves the caller's object as it was", async () => {
    defineModel("dbVal_insertRefusedDoc", validatedSchema as any, { dbValidation: true })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    const doc: any = { name: "a", qty: "three", userId: "u1" }
    await expect(async () => {
      await wrapped.model("dbVal_insertRefusedDoc").insertOne(doc)
    }).rejects.toThrow(/Validation failed/)
    expect(doc).toEqual({ name: "a", qty: "three", userId: "u1" })
  })
})

describe("wrapDbWithAutoStamp + timeseries", () => {
  let now: number
  beforeEach(() => {
    now = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(now)
  })

  it("stamps createdAt + updatedAt but NOT deletedAt on timeseries insertOne", async () => {
    defineModel("ts_widgets_one", undefined, { timeseries: { timeField: "ts" } })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("ts_widgets_one").insertOne({ ts: new Date(now), value: 42 })
    expect(db.collection.insertOne).toHaveBeenCalledTimes(1)
    const inserted = db.collection.insertOne.mock.calls[0][0]
    expect(inserted.value).toBe(42)
    expect(inserted.createdAt).toBe(now)
    expect(inserted.updatedAt).toBe(now)
    expect("deletedAt" in inserted).toBe(false)
  })

  it("writes no deletedAt back onto a timeseries caller's object", async () => {
    defineModel("ts_widgets_caller", undefined, { timeseries: { timeField: "ts" } })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    const doc: any = { ts: new Date(now), value: 1 }
    await wrapped.model("ts_widgets_caller").insertOne(doc)
    expect(doc.createdAt).toBe(now)
    expect(doc.updatedAt).toBe(now)
    expect("deletedAt" in doc).toBe(false)
  })

  it("stamps each row in timeseries insertMany without deletedAt", async () => {
    defineModel("ts_widgets_many", undefined, { timeseries: { timeField: "ts" } })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("ts_widgets_many").insertMany([
      { ts: new Date(now), value: 1 },
      { ts: new Date(now + 1000), value: 2 },
    ])
    const inserted = db.collection.insertMany.mock.calls[0][0]
    expect(inserted).toHaveLength(2)
    for (const row of inserted) {
      expect(row.createdAt).toBe(now)
      expect(row.updatedAt).toBe(now)
      expect("deletedAt" in row).toBe(false)
    }
  })

  it("passes deleteOne through to native delete on timeseries even when sync is unset", async () => {
    defineModel("ts_widgets_del", undefined, { timeseries: { timeField: "ts" } })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("ts_widgets_del").deleteOne({ sensorId: "s1" })
    expect(db.collection.deleteOne).toHaveBeenCalledWith({ sensorId: "s1" })
    expect(db.collection.updateOne).not.toHaveBeenCalled()
  })


  // ——— Upserts. An upsert that inserts is a BIRTH: it used to land with only
  // `updatedAt`, so `createdAt` was undefined and every screen rendering it read
  // `undefined` as NOW — a row that reports today, every day, forever.

  it("stamps createdAt + deletedAt in $setOnInsert on an upsert", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped
      .model("widgets")
      .updateOne({ key: "k" }, { $set: { hits: 1 }, $setOnInsert: { _id: "w1" } }, { upsert: true })
    const [, update] = db.collection.updateOne.mock.calls[0]
    expect(update.$set.updatedAt).toBe(now)
    expect(update.$setOnInsert).toEqual({ _id: "w1", createdAt: now, deletedAt: null })
    // The same path must never appear in both operators — MongoDB errors on it.
    expect(update.$set.createdAt).toBeUndefined()
  })

  it("leaves a plain update alone — no $setOnInsert without upsert", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").updateOne({ _id: "w1" }, { $set: { hits: 2 } })
    const [, update] = db.collection.updateOne.mock.calls[0]
    expect(update.$setOnInsert).toBeUndefined()
    expect(update.$set.updatedAt).toBe(now)
  })

  it("keeps a caller's own createdAt on an upsert", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped
      .model("widgets")
      .updateOne({ key: "k" }, { $setOnInsert: { createdAt: 42 } }, { upsert: true })
    const [, update] = db.collection.updateOne.mock.calls[0]
    expect(update.$setOnInsert.createdAt).toBe(42)
  })

  it("stamps an upserting findOneAndUpdate and updateMany too", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").findOneAndUpdate({ key: "k" }, { $set: { a: 1 } }, { upsert: true })
    expect(db.collection.findOneAndUpdate.mock.calls[0][1].$setOnInsert.createdAt).toBe(now)
    await wrapped.model("widgets").updateMany({ key: "k" }, { $set: { a: 1 } }, { upsert: true })
    expect(db.collection.updateMany.mock.calls[0][1].$setOnInsert.createdAt).toBe(now)
  })

  it("stamps a replaceOne, and gives an upserting one its birth stamps", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").replaceOne({ _id: "w1" }, { name: "b" })
    // A non-upsert replace is an update pipeline that keeps the stored row's createdAt / deletedAt
    // (round F8): the replacement itself carries a fresh updatedAt and no invented createdAt.
    const pipeline = db.collection.updateOne.mock.calls[0][1]
    const plain = pipeline[0].$replaceWith.$mergeObjects[1].$literal
    expect(plain.updatedAt).toBe(now)
    expect(plain.createdAt).toBeUndefined()
    await wrapped.model("widgets").replaceOne({ _id: "w2" }, { name: "c" }, { upsert: true })
    // An upsert is the same pipeline (round F9): birth stamps only when it inserts ($ifNull), the
    // stored ones kept when it matches; the upsert option passed on.
    const [, upsertPipeline, upsertOptions] = db.collection.updateOne.mock.calls[1]
    const [kept, literal] = upsertPipeline[0].$replaceWith.$mergeObjects
    expect(kept.createdAt).toEqual({ $ifNull: ["$createdAt", now] })
    expect(kept.deletedAt).toEqual({ $ifNull: ["$deletedAt", null] })
    expect(literal.$literal.updatedAt).toBe(now)
    expect(upsertOptions).toMatchObject({ upsert: true })
  })

  // ——— bulkWrite. It used to fall through to the driver untouched, so it was the
  // one write path that opted out of the contract entirely — and rollups reach for
  // it precisely because they write many rows, so the gap scaled with volume.

  it("stamps every operation kind in a bulkWrite", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").bulkWrite([
      { insertOne: { document: { _id: "a", name: "a" } } },
      { updateOne: { filter: { _id: "b" }, update: { $set: { n: 1 } }, upsert: true } },
      { updateMany: { filter: { k: 1 }, update: { $set: { n: 2 } } } },
      { replaceOne: { filter: { _id: "c" }, replacement: { name: "c" }, upsert: true } },
    ])
    const [ops] = db.collection.bulkWrite.mock.calls[0]
    expect(ops[0].insertOne.document).toMatchObject({ createdAt: now, updatedAt: now, deletedAt: null })
    expect(ops[1].updateOne.update.$set.updatedAt).toBe(now)
    expect(ops[1].updateOne.update.$setOnInsert).toEqual({ createdAt: now, deletedAt: null })
    expect(ops[1].updateOne.upsert).toBe(true)
    // No upsert on this one, so no birth stamps — it can only ever match rows
    // that already have them.
    expect(ops[2].updateMany.update.$setOnInsert).toBeUndefined()
    expect(ops[2].updateMany.update.$set.updatedAt).toBe(now)
    // A replace is an update pipeline keeping (or, on insert, stamping) the birth stamps (round F9).
    expect(ops[3].updateOne.upsert).toBe(true)
    const [kept, literal] = ops[3].updateOne.update[0].$replaceWith.$mergeObjects
    expect(kept.createdAt).toEqual({ $ifNull: ["$createdAt", now] })
    expect(literal.$literal).toMatchObject({ name: "c", updatedAt: now })
  })

  it("passes a bulkWrite delete through for a non-sync model", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").bulkWrite([{ deleteOne: { filter: { _id: "a" } } }])
    const [ops] = db.collection.bulkWrite.mock.calls[0]
    expect(ops[0].deleteOne).toBeDefined()
  })

  it("preserves consumer-supplied timestamps on timeseries inserts", async () => {
    defineModel("ts_widgets_keep", undefined, { timeseries: { timeField: "ts" } })
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("ts_widgets_keep").insertOne({
      ts: new Date(now - 5000),
      value: 1,
      createdAt: 100,
      updatedAt: 200,
    })
    const inserted = db.collection.insertOne.mock.calls[0][0]
    expect(inserted.createdAt).toBe(100)
    expect(inserted.updatedAt).toBe(200)
  })
})

describe("wrapDbWithAutoStamp: review round F5", () => {
  it("findOneAndDelete on a sync model with decimal fields returns decimal strings, as findOneAndUpdate does", async () => {
    const { Decimal128 } = await import("mongodb")
    const { v } = await import("@/server/handlers")
    defineModel("r5_synced_prices", { price: v.decimal128() }, { sync: true })
    const db = makeFakeDb()
    db.collection.findOneAndUpdate = vi.fn(async () => ({ _id: "p", price: Decimal128.fromString("9.99") }))
    db.collection.findOneAndDelete = vi.fn() // a sync model's delete is rewritten to the update above
    const doc: any = await wrapDbWithAutoStamp(db as any).model("r5_synced_prices").findOneAndDelete({ _id: "p" })
    expect(doc.price).toBe("9.99")
  })
})

describe("wrapDbWithAutoStamp: review round F7", () => {
  // A replacement cannot know the row's createdAt / deletedAt, which withSyncFields makes required:
  // validated as a full document, findOneAndReplace({ _id }, { name }) threw on a dbValidation
  // model, where on main it passed straight to the driver.
  it("a non-upsert replacement is validated without the engine stamps it cannot know; its own fields still are", async () => {
    defineModel("r7_validated", { name: z4.string() }, { dbValidation: true })
    const db = makeFakeDb()
    db.collection.findOneAndReplace = vi.fn(async () => null)
    const coll = wrapDbWithAutoStamp(db as any).model("r7_validated")
    await expect(coll.findOneAndReplace({ _id: "a" }, { name: "x" })).resolves.toBeDefined() // not refused
    await expect(coll.replaceOne({ _id: "a" }, { name: "x" })).resolves.toBeDefined()
    expect(() => coll.replaceOne({ _id: "a" }, { name: 5 })).toThrow(/Validation failed for r7_validated.replaceOne: name/)
  })

  // The soft-delete rewrite rebuilt bulkWrite's delete from its filter alone: a collation (a
  // case-insensitive match) or hint was dropped, and the row it named stayed live.
  it("bulkWrite's soft deletes keep the op's collation and hint", async () => {
    defineModel("r7_synced_bulk", undefined, { sync: true })
    const db = makeFakeDb()
    const collation = { locale: "en", strength: 2 }
    await wrapDbWithAutoStamp(db as any).model("r7_synced_bulk").bulkWrite([
      { deleteOne: { filter: { email: "A@x.com" }, collation, hint: "email_1" } },
      { deleteMany: { filter: { org: "o" }, hint: "org_1" } },
    ])
    const [ops] = db.collection.bulkWrite.mock.calls[0]
    expect(ops[0].updateOne).toMatchObject({ collation, hint: "email_1" })
    expect(ops[1].updateMany).toMatchObject({ hint: "org_1" })
  })
})

describe("wrapDbWithAutoStamp: review round F8", () => {
  // ctx.runMutation(name, args, { db: ctx.useDatabase("x") }) hands _runMutation a db already
  // wrapped, which it wrapped again: every write was stamped, validated and Decimal128-encoded
  // twice, and the second validation refused the encoded value of a valid v.decimal128() write.
  it("wrapping a wrapped db returns it as it is, so a write is stamped, validated and encoded once", async () => {
    const { v } = await import("@/server/handlers")
    defineModel("r8_priced", { amount: v.decimal128() }, { dbValidation: true })
    const db = makeFakeDb()
    const once = wrapDbWithAutoStamp(db as any)
    const twice = wrapDbWithAutoStamp(once)
    expect(twice).toBe(once)
    await twice.model("r8_priced").insertOne({ amount: "12.50" }) // threw "Validation failed"
    expect(db.collection.insertOne).toHaveBeenCalledTimes(1)
    expect(String(db.collection.insertOne.mock.calls[0][0].amount)).toBe("12.50")
  })
})
describe("wrapDbWithAutoStamp: review round F11", () => {
  // zod v4 refuses .partial() on an object schema carrying a refinement. The replace check used it
  // (to leave out the stamps a replacement cannot know), so every replace on such a model threw
  // ".partial() cannot be used on object schemas containing refinements" — on main the replace was
  // checked as a full document and passed. A $set check threw the same way (on main too).
  const refined = () => z4.object({ a: z4.number(), b: z4.number() }).refine((d) => d.a <= d.b, { message: "a above b" })

  it("a replace on a model whose schema has a refinement is checked as a whole document, refinement included", async () => {
    defineModel("r11_refined_replace", refined() as any, { dbValidation: true })
    const db = makeFakeDb()
    const coll = wrapDbWithAutoStamp(db as any).model("r11_refined_replace")
    await expect(coll.replaceOne({ _id: "x" }, { a: 1, b: 2 })).resolves.toBeDefined()
    expect(db.collection.updateOne).toHaveBeenCalledTimes(1)
    expect(() => coll.replaceOne({ _id: "x" }, { a: "1", b: 2 })).toThrow(/Validation failed for r11_refined_replace.replaceOne: a/)
    expect(() => coll.replaceOne({ _id: "x" }, { a: 3, b: 2 })).toThrow(/Validation failed for r11_refined_replace.replaceOne: .*a above b/)
  })

  it("a $set on a model whose schema has a refinement checks each field it sets", async () => {
    defineModel("r11_refined_set", refined() as any, { dbValidation: true })
    const db = makeFakeDb()
    const coll = wrapDbWithAutoStamp(db as any).model("r11_refined_set")
    await expect(coll.updateOne({ _id: "x" }, { $set: { a: 5 } })).resolves.toBeDefined()
    expect(db.collection.updateOne).toHaveBeenCalledTimes(1)
    expect(() => coll.updateOne({ _id: "x" }, { $set: { a: "5" } })).toThrow(/Validation failed for r11_refined_set.updateOne: a/)
  })
})

describe("wrapDbWithAutoStamp: review round F13", () => {
  // Every validated $set built its partial schema anew (a clone without refinements, then
  // .partial()), and a plain-shape model's schema was rebuilt as a z.object on every lookup:
  // two or three new zod objects per write on a dbValidation model under load.
  it("builds a model's schema, and its partial, once", async () => {
    const { getModelZodSchema } = await import("@/runtime/models")
    defineModel("f13_shape", { name: z4.string() }, { dbValidation: true })
    expect(getModelZodSchema("f13_shape")).toBe(getModelZodSchema("f13_shape"))
    defineModel("f13_object", z4.object({ name: z4.string() }), { dbValidation: true })
    const partial = vi.spyOn(getModelZodSchema("f13_object"), "partial")
    const db = makeFakeDb()
    const coll = wrapDbWithAutoStamp(db as any).model("f13_object")
    await coll.updateOne({ _id: "a" }, { $set: { name: "x" } })
    await coll.updateOne({ _id: "b" }, { $set: { name: "y" } })
    expect(partial).toHaveBeenCalledTimes(1)
  })
})
