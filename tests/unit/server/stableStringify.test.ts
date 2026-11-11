import { describe, it, expect } from "vitest"
import { stableStringify } from "@/server/stableStringify"

describe("stableStringify", () => {
  it("produces same string for objects with reordered keys", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
  })

  it("handles nested objects", () => {
    expect(stableStringify({ x: { c: 3, a: 1, b: 2 } })).toBe(
      stableStringify({ x: { a: 1, b: 2, c: 3 } })
    )
  })

  it("handles arrays preserving order", () => {
    expect(stableStringify({ a: [1, 2, 3] })).not.toBe(stableStringify({ a: [3, 2, 1] }))
  })

  it("handles primitives", () => {
    expect(stableStringify("hello")).toBe('"hello"')
    expect(stableStringify(42)).toBe("42")
    expect(stableStringify(null)).toBe("null")
    expect(stableStringify(true)).toBe("true")
  })

  it("handles undefined values by omitting them", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
  })
})

describe("stableStringify: values with no own keys", () => {
  // These all printed as "{}", so two watches on different ids shared one key.
  it("tells ObjectIds, Dates and RegExps apart", async () => {
    const { ObjectId } = await import("mongodb")
    const a = new ObjectId()
    const b = new ObjectId()
    expect(stableStringify({ _id: a })).not.toBe(stableStringify({ _id: b }))
    expect(stableStringify({ _id: a })).toBe(stableStringify({ _id: new ObjectId(a.toHexString()) }))
    expect(stableStringify(new Date(1))).not.toBe(stableStringify(new Date(2)))
    expect(stableStringify(/a/i)).not.toBe(stableStringify(/b/i))
  })
})

describe("stableStringify: BSON values print by everything that tells them apart", () => {
  it("Binary by bytes and subtype, Code by code and scope", async () => {
    const { Binary, Code, UUID, Decimal128 } = await import("mongodb")
    // Bytes that are not valid UTF-8 used to decode to the same replacement characters.
    const a = new Binary(Buffer.from([0xff, 0xfe]), 0)
    const b = new Binary(Buffer.from([0xfe, 0xff]), 0)
    expect(stableStringify(a)).not.toBe(stableStringify(b))
    expect(stableStringify(a)).toBe(stableStringify(new Binary(Buffer.from([0xff, 0xfe]), 0)))
    expect(stableStringify(a)).not.toBe(stableStringify(new Binary(Buffer.from([0xff, 0xfe]), 5)))
    expect(stableStringify(new UUID())).not.toBe(stableStringify(new UUID()))
    expect(stableStringify(new Code("f()"))).not.toBe(stableStringify(new Code("g()")))
    expect(stableStringify(new Code("f()", { a: 1 }))).not.toBe(stableStringify(new Code("f()", { a: 2 })))
    expect(stableStringify(Decimal128.fromString("1.5"))).not.toBe(stableStringify(Decimal128.fromString("1.6")))
  })
})

describe("stableStringify: BSON values with no JSON form", () => {
  it("BSONRegExp by pattern and options; MinKey and MaxKey apart", async () => {
    const { BSONRegExp, MinKey, MaxKey } = await import("mongodb")
    expect(stableStringify(new BSONRegExp("^a", "i"))).not.toBe(stableStringify(new BSONRegExp("^b", "i")))
    expect(stableStringify(new BSONRegExp("^a", "i"))).not.toBe(stableStringify(new BSONRegExp("^a", "m")))
    expect(stableStringify(new BSONRegExp("^a", "i"))).toBe(stableStringify(new BSONRegExp("^a", "i")))
    expect(stableStringify(new MinKey())).not.toBe(stableStringify(new MaxKey()))
  })
})

describe("stableStringify: values that printed alike (review round 5)", () => {
  it("a bigint is not the equal number", () => {
    expect(stableStringify(5n)).not.toBe(stableStringify(5))
    expect(stableStringify(5n)).toBe(stableStringify(BigInt(5)))
  })

  it("a Map or Set prints by content, whatever order it was filled in", () => {
    expect(stableStringify(new Map([["a", 1]]))).not.toBe(stableStringify(new Map([["a", 2]])))
    expect(stableStringify(new Map([["a", 1], ["b", 2]]))).toBe(stableStringify(new Map([["b", 2], ["a", 1]])))
    expect(stableStringify(new Set([1, 2]))).not.toBe(stableStringify(new Set([1, 3])))
    expect(stableStringify(new Set([2, 1]))).toBe(stableStringify(new Set([1, 2])))
    expect(stableStringify({ in: new Set(["x"]) })).not.toBe(stableStringify({ in: new Set(["y"]) }))
  })
})

describe("stableStringify: a typed value never prints as a plain one (review round 6)", () => {
  it("a Date, an ObjectId, a Map and a bigint differ from plain objects of their old printed shape", async () => {
    const { ObjectId } = await import("mongodb")
    const d = new Date(0)
    expect(stableStringify(d)).not.toBe(stableStringify({ $date: d.toISOString() }))
    const id = new ObjectId()
    expect(stableStringify(id)).not.toBe(stableStringify({ $ObjectId: id.toHexString() }))
    expect(stableStringify(new Map([["a", 1]]))).not.toBe(stableStringify({ $Map: [["a", 1]] }))
    expect(stableStringify(5n)).not.toBe(stableStringify({ $bigint: "5" }))
    expect(stableStringify(undefined)).not.toBe(stableStringify(null))
  })
})

describe("stableStringify: review round F6", () => {
  it("with sortKeys false, keeps object key order (embedded-document equality is order-sensitive)", () => {
    expect(stableStringify({ b: 1, a: 2 }, false)).not.toBe(stableStringify({ a: 2, b: 1 }, false))
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  it("watch keys tell { a, b } from { b, a } in a filter", async () => {
    const { watchKey } = await import("@/server/changeStreamWatch")
    const key = (filter: unknown) => watchKey({ kind: "hub", dbName: "db", model: "m", filter })
    expect(key({ loc: { b: 2, a: 1 } })).not.toBe(key({ loc: { a: 1, b: 2 } }))
  })
})

describe("filterKey: review round F6", () => {
  it("sorts a filter's conditions and operators, keeps an embedded document's order", async () => {
    const { filterKey } = await import("@/server/stableStringify")
    expect(filterKey({ a: 1, b: 2 })).toBe(filterKey({ b: 2, a: 1 }))
    expect(filterKey({ n: { $gt: 1, $lt: 5 } })).toBe(filterKey({ n: { $lt: 5, $gt: 1 } }))
    expect(filterKey({ addr: { zip: 1, city: "x" } })).not.toBe(filterKey({ addr: { city: "x", zip: 1 } }))
    expect(filterKey({ addr: { $in: [{ zip: 1, city: "x" }] } })).not.toBe(filterKey({ addr: { $in: [{ city: "x", zip: 1 }] } }))
    expect(filterKey({ $or: [{ a: 1, b: 2 }] })).toBe(filterKey({ $or: [{ b: 2, a: 1 }] }))
    expect(filterKey([{ $match: { a: 1, b: 2 } }])).toBe(filterKey([{ $match: { b: 2, a: 1 } }]))
  })
})

describe("filterKey: review round F8", () => {
  // $in / $nin / $all are sets: a list built in a different order on each run (an unsorted find,
  // a Set) gave a new key every re-run — the watch reopened and a catch-up run followed each write.
  it("orders the members of $in / $nin / $all", async () => {
    const { filterKey } = await import("@/server/stableStringify")
    expect(filterKey({ _id: { $in: ["b", "a", "c"] } })).toBe(filterKey({ _id: { $in: ["c", "a", "b"] } }))
    expect(filterKey({ tags: { $all: [2, 1] }, x: { $nin: [3, 1] } })).toBe(filterKey({ tags: { $all: [1, 2] }, x: { $nin: [1, 3] } }))
    expect(filterKey({ addr: { $in: [{ zip: 1, city: "x" }] } })).not.toBe(filterKey({ addr: { $in: [{ city: "x", zip: 1 }] } }))
  })
})
