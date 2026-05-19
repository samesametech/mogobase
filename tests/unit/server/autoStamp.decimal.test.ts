// tests/unit/server/autoStamp.decimal.test.ts
// Decimal128 codec wired through the autoStamp db wrapper: schema-guided
// string→Decimal128 on writes, schema-agnostic Decimal128→string on reads.
import { describe, it, expect } from "vitest"
import { Decimal128 } from "mongodb"
import { wrapDbWithAutoStamp } from "@/server/autoStamp"
import { defineModel } from "@/runtime/models"
import { v } from "@/server/handlers"

function isDec(x: any): boolean {
  return !!x && typeof x === "object" && x._bsontype === "Decimal128"
}

// Fake collection: write methods record their args; read methods return
// canned docs (carrying real Decimal128) through a minimal chainable cursor.
function makeFakeDb(readDocs: any[] = []) {
  const calls: { method: string; args: any[] }[] = []
  const cursor = {
    sort() {
      return cursor
    },
    limit() {
      return cursor
    },
    toArray() {
      return Promise.resolve(readDocs)
    },
  }
  const collection: any = {
    insertOne: (...a: any[]) => {
      calls.push({ method: "insertOne", args: a })
      return Promise.resolve({ acknowledged: true })
    },
    insertMany: (...a: any[]) => {
      calls.push({ method: "insertMany", args: a })
      return Promise.resolve({ acknowledged: true })
    },
    updateOne: (...a: any[]) => {
      calls.push({ method: "updateOne", args: a })
      return Promise.resolve({ acknowledged: true })
    },
    findOneAndUpdate: (...a: any[]) => {
      calls.push({ method: "findOneAndUpdate", args: a })
      return Promise.resolve(readDocs[0] ?? null)
    },
    findOne: (...a: any[]) => {
      calls.push({ method: "findOne", args: a })
      return Promise.resolve(readDocs[0] ?? null)
    },
    find: (...a: any[]) => {
      calls.push({ method: "find", args: a })
      return cursor
    },
    aggregate: (...a: any[]) => {
      calls.push({ method: "aggregate", args: a })
      return cursor
    },
  }
  return { model: () => collection, calls, collection }
}

// Models registered once at module load (defineModel is process-global).
defineModel("dec_widgets", v.object({
  _id: v.string(),
  amount: v.decimal128(),
  fee: v.object({ rate: v.decimal128() }),
  name: v.string(),
}), { dbValidation: true })

defineModel("plain_widgets", v.object({
  _id: v.string(),
  name: v.string(),
}))

describe("autoStamp Decimal128 — write encode", () => {
  it("encodes a declared decimal string to Decimal128 on insertOne", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("dec_widgets").insertOne({ _id: "1", amount: "100.14", fee: { rate: "0.0035" }, name: "x" })
    const inserted = db.calls.find((c) => c.method === "insertOne")!.args[0]
    expect(isDec(inserted.amount)).toBe(true)
    expect(inserted.amount.toString()).toBe("100.14")
    expect(isDec(inserted.fee.rate)).toBe(true)
    expect(inserted.fee.rate.toString()).toBe("0.0035")
    expect(inserted.name).toBe("x")
  })

  it("encodes $set decimal values on updateOne", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("dec_widgets").updateOne({ _id: "1" }, { $set: { amount: "9.99" } })
    const update = db.calls.find((c) => c.method === "updateOne")!.args[1]
    expect(isDec(update.$set.amount)).toBe(true)
    expect(update.$set.amount.toString()).toBe("9.99")
  })

  it("encodes dotted-path $set keys on findOneAndUpdate", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("dec_widgets").findOneAndUpdate({ _id: "1" }, { $set: { "fee.rate": "0.10" } })
    const update = db.calls.find((c) => c.method === "findOneAndUpdate")!.args[1]
    expect(isDec(update.$set["fee.rate"])).toBe(true)
    expect(update.$set["fee.rate"].toString()).toBe("0.10")
  })

  it("does not touch a model with no decimal fields", async () => {
    const db = makeFakeDb()
    const wrapped = wrapDbWithAutoStamp(db as any)
    await wrapped.model("plain_widgets").insertOne({ _id: "1", name: "y" })
    const inserted = db.calls.find((c) => c.method === "insertOne")!.args[0]
    expect(inserted.name).toBe("y")
  })
})

describe("autoStamp Decimal128 — read decode", () => {
  it("decodes Decimal128 to string on findOne", async () => {
    const db = makeFakeDb([{ _id: "1", amount: Decimal128.fromString("100.14"), fee: { rate: Decimal128.fromString("0.0035") }, name: "x" }])
    const wrapped = wrapDbWithAutoStamp(db as any)
    const doc = await wrapped.model("dec_widgets").findOne({ _id: "1" })
    expect(doc.amount).toBe("100.14")
    expect(doc.fee.rate).toBe("0.0035")
    expect(doc.name).toBe("x")
  })

  it("decodes Decimal128 through a find() cursor toArray()", async () => {
    const db = makeFakeDb([
      { _id: "1", amount: Decimal128.fromString("1.00") },
      { _id: "2", amount: Decimal128.fromString("2.50") },
    ])
    const wrapped = wrapDbWithAutoStamp(db as any)
    const rows = await wrapped.model("dec_widgets").find({}).sort({ _id: 1 }).limit(10).toArray()
    expect(rows[0].amount).toBe("1.00")
    expect(rows[1].amount).toBe("2.50")
  })

  it("decodes Decimal128 through an aggregate() cursor", async () => {
    const db = makeFakeDb([{ _id: "1", total: Decimal128.fromString("42.00") }])
    const wrapped = wrapDbWithAutoStamp(db as any)
    const rows = await wrapped.model("dec_widgets").aggregate([{ $group: { _id: null } }]).toArray()
    expect(rows[0].total).toBe("42.00")
  })

  it("decodes the returned doc from findOneAndUpdate", async () => {
    const db = makeFakeDb([{ _id: "1", amount: Decimal128.fromString("7.77"), name: "x" }])
    const wrapped = wrapDbWithAutoStamp(db as any)
    const doc = await wrapped.model("dec_widgets").findOneAndUpdate({ _id: "1" }, { $set: { amount: "7.77" } })
    expect(doc.amount).toBe("7.77")
  })
})
