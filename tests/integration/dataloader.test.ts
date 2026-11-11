// DataLoaderGenerate with string ids. It wrapped every id in `new ObjectId(id)`, which throws
// on anything that is not 24 hex characters — a collection keyed by prefixed ULIDs could not
// use it at all.

import { beforeAll, describe, expect, it, vi } from "vitest"
import { Binary, ObjectId } from "mongodb"
import { connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import DB, { DataLoaderGenerate } from "@/db"

const MODEL = "dataloader_ids"
const oid = new ObjectId()
const hexString = "65a1b2c3d4e5f60718293a4b" // a STRING _id that happens to be 24 hex characters

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await db.collection(MODEL).deleteMany({})
  await db.collection(MODEL).insertMany([
    { _id: "usr_01HXYZ" as any, name: "ulid" },
    { _id: oid, name: "objectid" },
    { _id: hexString as any, name: "hex string" },
    { _id: "usr_02ABC" as any, name: "other", ref: "usr_01HXYZ" },
  ])
  await client.close()
})

describe("DataLoaderGenerate", () => {
  it("loads string ids, ObjectId ids and 24-hex string ids, in the order asked", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const loader = DataLoaderGenerate(MODEL)
    const rows = await loader.loadMany(["usr_01HXYZ", oid.toHexString(), hexString, "usr_missing"])
    expect(rows.map((r: any) => r?.name)).toEqual(["ulid", "objectid", "hex string", undefined])
    vi.restoreAllMocks()
  })

  it("works on a key other than _id", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const byRef = DataLoaderGenerate(MODEL, "ref")
    expect((await byRef.load("usr_01HXYZ"))?.name).toBe("other")
    vi.restoreAllMocks()
  })
})

describe("DataLoaderGenerate: the edges", () => {
  it("a 24-hex id held both as an ObjectId and as a string resolves to the ObjectId row", async () => {
    const hex = new ObjectId().toHexString()
    const { db, client } = await connectTestMongo("mogobase_test_integration")
    // The string row first, so insertion order cannot be what picks the answer.
    await db.collection(MODEL).insertMany([{ _id: hex as any, name: "string twin" }, { _id: new ObjectId(hex), name: "objectid twin" }])
    await client.close()
    expect((await DataLoaderGenerate(MODEL).load(hex))?.name).toBe("objectid twin")
  })

  it("logs a batch only when MOGOBASE_DEBUG is set", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await DataLoaderGenerate(MODEL).load("usr_01HXYZ")
    expect(log).not.toHaveBeenCalled()
    process.env.MOGOBASE_DEBUG = "1"
    try {
      await DataLoaderGenerate(MODEL).load("usr_01HXYZ")
      expect(log).toHaveBeenCalledWith("DataLoader", MODEL, "_id", ["usr_01HXYZ"])
    } finally {
      delete process.env.MOGOBASE_DEBUG
      log.mockRestore()
    }
  })
})

describe("DataLoaderGenerate: a large batch", () => {
  it("resolves 2,000 ids to their rows, in order", async () => {
    const { db, client } = await connectTestMongo("mogobase_test_integration")
    const rows = Array.from({ length: 2000 }, (_, i) => ({ _id: `bulk_${i}` as any, n: i }))
    await db.collection(MODEL).insertMany(rows)
    await client.close()
    const ids = rows.map((r) => r._id as string).reverse()
    const got = await DataLoaderGenerate(MODEL).loadMany(ids)
    expect(got.map((r: any) => r?.n)).toEqual(ids.map((id) => Number(id.slice(5))))
  })
})

describe("DataLoaderGenerate: ids of different types (review round 3)", () => {
  it("the number 5 and the string \"5\" are different ids", async () => {
    const { db, client } = await connectTestMongo("mogobase_test_integration")
    await db.collection(MODEL).insertMany([
      { _id: "typed_num" as any, code: 5, name: "number" },
      { _id: "typed_str" as any, code: "5", name: "string" },
    ])
    await client.close()
    const byCode = DataLoaderGenerate(MODEL, "code")
    const rows = await byCode.loadMany([5 as any, "5"])
    expect(rows.map((r: any) => r?.name)).toEqual(["number", "string"])
  })

  it("an upper-case hex id finds its ObjectId row", async () => {
    expect((await DataLoaderGenerate(MODEL).load(oid.toHexString().toUpperCase()))?.name).toBe("objectid")
  })
})

describe("DataLoaderGenerate: binary ids (review round 4)", () => {
  it("two UUIDs whose bytes print alike are different ids", async () => {
    // Neither 0xff nor 0xfe is valid UTF-8: as text both print as the same replacement character.
    const a = new Binary(Buffer.from([0xff, 1, 2, 3]), 4)
    const b = new Binary(Buffer.from([0xfe, 1, 2, 3]), 4)
    const { db, client } = await connectTestMongo("mogobase_test_integration")
    await db.collection(MODEL).insertMany([
      { _id: "bin_a" as any, uid: a, name: "a" },
      { _id: "bin_b" as any, uid: b, name: "b" },
    ])
    await client.close()
    const rows = await DataLoaderGenerate(MODEL, "uid").loadMany([a as any, b as any])
    expect(rows.map((r: any) => r?.name)).toEqual(["a", "b"])
  })
})
