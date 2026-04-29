import { describe, it, expect, beforeAll } from "vitest"
import { getTestMongoUri } from "../helpers/mongo"
import { matches } from "@/runtime/filterMatcher"
import DB from "@/db"

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
})

const docs = [
  { _id: "1", userId: "u1", role: "admin",  age: 10, tags: ["x", "y"] },
  { _id: "2", userId: "u1", role: "member", age: 25, tags: ["x"] },
  { _id: "3", userId: "u2", role: "admin",  age: 25, tags: [] },
  { _id: "4", userId: "u2", role: "member", age: 50, tags: ["y", "z"] },
  { _id: "5", userId: "u3", role: "member", age: 50, tags: null },
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
    it(`matches MongoDB for filter ${JSON.stringify(filter)}`, async () => {
      const mongoIds = (await DB.model("parity_parity").find(filter).toArray())
        .map((d: any) => d._id)
        .sort()
      const jsIds = docs.filter((d) => matches(d, filter)).map((d) => d._id).sort()
      expect(jsIds).toEqual(mongoIds)
    })
  }
})
