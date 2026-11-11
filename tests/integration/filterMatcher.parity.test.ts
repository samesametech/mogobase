import { describe, it, expect, beforeAll } from "vitest"
import { inspect } from "node:util"
import { Decimal128, Long } from "mongodb"
import { getTestMongoUri } from "../helpers/mongo"
import { matches } from "@/runtime/filterMatcher"
import DB from "@/db"

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
})

const docs = [
  { _id: "1", userId: "u1", role: "admin",  age: 10, tags: ["x", "y"], score: 5 },
  { _id: "2", userId: "u1", role: "member", age: 25, tags: ["x"], score: "25" },
  { _id: "3", userId: "u2", role: "admin",  age: 25, tags: [], score: null },
  { _id: "4", userId: "u2", role: "member", age: 50, tags: ["y", "z"], score: false },
  { _id: "5", userId: "u3", role: "member", age: 50, tags: null },
  // Review round 13: arrays of documents, numbers stored as Decimal128.
  { _id: "6", userId: "u4", role: "Admin", age: 7, tags: ["a"], items: [{ sku: "k1", qty: 2 }, { sku: "k2", qty: 9 }], price: Decimal128.fromString("100.50"), score: Decimal128.fromString("7"), addr: { zip: "1", city: "x" } },
  { _id: "7", userId: "u4", role: "member", age: 8, tags: ["z"], items: [{ sku: "k2", qty: 1 }], price: Decimal128.fromString("5.0"), big: Long.fromString("9007199254740993"), score: true },
]

const filterCases: any[] = [
  {},
  { userId: "u1" },
  { age: { $gt: 20 } },
  { age: { $gte: 25, $lte: 50 } },
  { role: { $in: ["admin", "member"] } },
  { role: { $nin: ["admin"] } },
  { $and: [{ userId: "u1" }, { role: "admin" }] },
  { $or: [{ role: "admin" }, { age: 50 }] },
  { tags: { $exists: true } },
  { userId: { $ne: "u1" } },
  // Review round 13: MongoDB's array semantics, regex literals, numbers across BSON types. The
  // JS matcher compared `{ tags: "x" }` with the whole array, a RegExp as a key-less object, and
  // Decimal128 by its JSON text — so with server-side filters it dropped events MongoDB matched.
  { tags: "x" },
  { tags: ["x"] },
  { tags: { $in: ["z", "a"] } },
  { tags: { $nin: ["x"] } },
  { tags: { $ne: "x" } },
  { tags: null },
  { tags: { $ne: null } },
  { tags: { $gt: "x" } },
  { role: /^adm/i },
  { role: { $in: [/^mem/] } },
  { tags: /^z/ },
  { "items.sku": "k2" },
  { "items.qty": { $gt: 5 } },
  { "items.sku": { $exists: true } },
  { "items.sku": { $exists: false } },
  { "items.0.sku": "k1" },
  { price: { $gte: 50 } },
  { price: 5 },
  { price: Decimal128.fromString("100.5") },
  { price: { $lt: Decimal128.fromString("6") } },
  { price: { $in: [5, 7] } },
  { big: Long.fromString("9007199254740993"), score: true },
  { big: { $gt: Long.fromString("9007199254740992") } },
  // Review round 14: $options applies to a RegExp $regex too; ranges compare within a type
  // (MongoDB's type bracketing) — null, "25" and false are not below 10.
  { role: { $regex: /^ADM/, $options: "i" } },
  { score: { $lt: 10 } },
  { score: { $gte: 0 } },
  { score: { $gt: "1" } },
  { score: { $lt: true } },
  { score: { $lte: Decimal128.fromString("5") } },
  // Review round 15: a null operand — JavaScript's 5 > null and 0 >= null were true.
  { score: { $gt: null } },
  { score: { $lt: null } },
  { score: { $gte: null } },
  { score: { $lte: null } },
  // Review round F3: an embedded document equals only with its fields in the same order.
  { addr: { zip: "1", city: "x" } },
  { addr: { city: "x", zip: "1" } },
  { addr: { $in: [{ city: "x", zip: "1" }] } },
]

describe("filterMatcher parity with MongoDB", () => {
  beforeAll(async () => {
    await DB.model("parity_parity").deleteMany({})
    for (const d of docs) {
      await DB.model("parity_parity").insertOne({
        ...d,
        _id: d._id as any,
        createdAt: 0,
        updatedAt: 0,
        deletedAt: null,
      })
    }
  })

  for (const filter of filterCases) {
    it(`matches MongoDB for filter ${inspect(filter, { breakLength: Infinity })}`, async () => {
      const mongoIds = (await DB.model("parity_parity").find(filter).toArray())
        .map((d: any) => d._id)
        .sort()
      const jsIds = docs.filter((d) => matches(d, filter)).map((d) => d._id).sort()
      expect(jsIds).toEqual(mongoIds)
    })
  }
})
