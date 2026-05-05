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
})
