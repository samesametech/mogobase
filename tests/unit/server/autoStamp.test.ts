// tests/unit/server/autoStamp.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { wrapDbWithAutoStamp } from "@/server/autoStamp"

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
  }
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

  it("rewrites deleteOne into soft-delete updateOne", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").deleteOne({ _id: "x" })
    // The Proxy should NOT call collection.deleteOne; it should call updateOne
    // with $set: {deletedAt: now, updatedAt: now}.
    expect(db.collection.deleteOne).not.toHaveBeenCalled()
    expect(db.collection.updateOne).toHaveBeenCalledTimes(1)
    const update = db.collection.updateOne.mock.calls[0][1]
    expect(update.$set.deletedAt).toBe(now)
    expect(update.$set.updatedAt).toBe(now)
  })

  it("rewrites deleteMany into soft-delete updateMany", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("widgets").deleteMany({ active: false })
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
