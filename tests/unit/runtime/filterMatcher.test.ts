// tests/unit/runtime/filterMatcher.test.ts
import { describe, it, expect } from "vitest"
import { matches, isSupportedFilter, getPath, deepEqual } from "@/runtime/filterMatcher"

describe("matches: scalar equality", () => {
  it("matches plain equality", () => {
    expect(matches({ a: 1 }, { a: 1 })).toBe(true)
    expect(matches({ a: 1 }, { a: 2 })).toBe(false)
  })

  it("matches nested objects via dotted path", () => {
    expect(matches({ a: { b: { c: 5 } } }, { "a.b.c": 5 })).toBe(true)
    expect(matches({ a: { b: { c: 5 } } }, { "a.b.c": 6 })).toBe(false)
  })

  it("treats null as null-or-undefined", () => {
    expect(matches({ a: null }, { a: null })).toBe(true)
    expect(matches({}, { a: null })).toBe(true)
    expect(matches({ a: 0 }, { a: null })).toBe(false)
  })
})

describe("matches: comparison operators", () => {
  it("supports $eq and $ne", () => {
    expect(matches({ a: 1 }, { a: { $eq: 1 } })).toBe(true)
    expect(matches({ a: 1 }, { a: { $ne: 2 } })).toBe(true)
    expect(matches({ a: 1 }, { a: { $ne: 1 } })).toBe(false)
  })

  it("supports $gt/$gte/$lt/$lte", () => {
    expect(matches({ a: 5 }, { a: { $gt: 3 } })).toBe(true)
    expect(matches({ a: 5 }, { a: { $gte: 5 } })).toBe(true)
    expect(matches({ a: 5 }, { a: { $lt: 10 } })).toBe(true)
    expect(matches({ a: 5 }, { a: { $lte: 5 } })).toBe(true)
    expect(matches({ a: 5 }, { a: { $gt: 5 } })).toBe(false)
  })

  it("supports $in and $nin", () => {
    expect(matches({ a: 2 }, { a: { $in: [1, 2, 3] } })).toBe(true)
    expect(matches({ a: 4 }, { a: { $in: [1, 2, 3] } })).toBe(false)
    expect(matches({ a: 4 }, { a: { $nin: [1, 2, 3] } })).toBe(true)
    expect(matches({ a: 2 }, { a: { $nin: [1, 2, 3] } })).toBe(false)
  })

  it("supports $exists", () => {
    expect(matches({ a: 1 }, { a: { $exists: true } })).toBe(true)
    expect(matches({}, { a: { $exists: false } })).toBe(true)
    expect(matches({ a: undefined }, { a: { $exists: true } })).toBe(false)
  })

  it("supports $regex (string and RegExp)", () => {
    expect(matches({ s: "hello" }, { s: { $regex: "ell" } })).toBe(true)
    expect(matches({ s: "hello" }, { s: { $regex: /^hel/ } })).toBe(true)
    expect(matches({ s: "hello" }, { s: { $regex: "^xyz$" } })).toBe(false)
  })
})

describe("matches: logical operators", () => {
  it("supports $and", () => {
    const f = { $and: [{ a: 1 }, { b: 2 }] }
    expect(matches({ a: 1, b: 2 }, f)).toBe(true)
    expect(matches({ a: 1, b: 3 }, f)).toBe(false)
  })

  it("supports $or", () => {
    const f = { $or: [{ a: 1 }, { b: 2 }] }
    expect(matches({ a: 1, b: 99 }, f)).toBe(true)
    expect(matches({ a: 99, b: 2 }, f)).toBe(true)
    expect(matches({ a: 99, b: 99 }, f)).toBe(false)
  })

  it("supports $not", () => {
    expect(matches({ a: 1 }, { $not: { a: 2 } })).toBe(true)
    expect(matches({ a: 1 }, { $not: { a: 1 } })).toBe(false)
  })
})

describe("matches: edge cases", () => {
  it("returns true for empty filter", () => {
    expect(matches({ a: 1 }, {})).toBe(true)
  })

  it("returns false for unknown operator (tolerant — does not throw)", () => {
    // Should not throw. Unknown ops short-circuit to non-match per matchesValue.
    expect(() => matches({ a: 1 }, { a: { $weirdop: 1 } })).not.toThrow()
  })
})

describe("isSupportedFilter", () => {
  it("returns true for supported scalars and ops", () => {
    expect(isSupportedFilter({ a: 1 })).toBe(true)
    expect(isSupportedFilter({ a: { $eq: 1, $lt: 10 } })).toBe(true)
    expect(isSupportedFilter({ $and: [{ a: 1 }, { b: { $in: [1] } }] })).toBe(true)
    expect(isSupportedFilter(undefined)).toBe(true)
    expect(isSupportedFilter(null)).toBe(true)
  })

  it("returns false for $expr/$where/$elemMatch/$text", () => {
    expect(isSupportedFilter({ $expr: { $eq: ["$a", "$b"] } })).toBe(false)
    expect(isSupportedFilter({ $where: "this.a > 1" })).toBe(false)
    expect(isSupportedFilter({ a: { $elemMatch: { x: 1 } } })).toBe(false)
    expect(isSupportedFilter({ $text: { $search: "hi" } })).toBe(false)
  })

  it("returns false for nested unsupported operators", () => {
    expect(isSupportedFilter({ $or: [{ a: 1 }, { $expr: {} }] })).toBe(false)
  })
})

describe("getPath / deepEqual", () => {
  it("getPath handles missing intermediates", () => {
    expect(getPath({ a: null }, "a.b.c")).toBe(null)
    expect(getPath({}, "a.b")).toBeUndefined()
  })

  it("deepEqual on objects, arrays, primitives", () => {
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(deepEqual([1, 2], [1, 2])).toBe(true)
    expect(deepEqual({ a: [1] }, { a: [1] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })
})

describe("filterMatcher: review round 10", () => {
  it("compares Dates and BSON values by value, not as key-less objects", async () => {
    const { ObjectId } = await import("mongodb")
    const day = new Date("2026-01-01")
    expect(matches({ day: new Date("2026-01-01") }, { day })).toBe(true)
    expect(matches({ day: new Date("2026-02-01") }, { day })).toBe(false)
    expect(matches({ day: new Date("2026-02-01") }, { day: { $ne: day } })).toBe(true)
    expect(matches({ day: new Date("2026-02-01") }, { day: { $in: [day] } })).toBe(false)
    const a = new ObjectId()
    const b = new ObjectId()
    expect(matches({ ownerId: new ObjectId(a.toHexString()) }, { ownerId: a })).toBe(true)
    expect(matches({ ownerId: b }, { ownerId: a })).toBe(false) // another owner's row
    expect(matches({ ownerId: b }, { ownerId: { $nin: [a] } })).toBe(true)
  })

  it("supports $nor, so a filter with one stays on the shared stream", async () => {
    const { isSupportedFilter } = await import("@/runtime/filterMatcher")
    expect(matches({ a: 1 }, { $nor: [{ a: 2 }, { b: 1 }] })).toBe(true)
    expect(matches({ a: 2 }, { $nor: [{ a: 2 }, { b: 1 }] })).toBe(false)
    expect(isSupportedFilter({ $nor: [{ a: 1 }] })).toBe(true)
  })
})

describe("filterMatcher: review round 14", () => {
  it("a $regex JavaScript cannot compile is not run by the matcher (MongoDB runs it, on a stream of its own)", async () => {
    const { unsupportedOperator, matches } = await import("@/runtime/filterMatcher")
    expect(unsupportedOperator({ name: { $regex: "a b", $options: "x" } })).toBe("$regex") // no x flag in JS
    expect(unsupportedOperator({ name: { $regex: "(?i)bob" } })).toBe("$regex") // PCRE inline flag
    expect(unsupportedOperator({ name: { $regex: "^bob", $options: "i" } })).toBeUndefined()
    expect(unsupportedOperator({ name: { $regex: /^bob/, $options: "i" } })).toBeUndefined()
    // Evaluated anyway (an offline query), it matches nothing instead of throwing.
    expect(() => matches({ name: "ab" }, { name: { $regex: "a b", $options: "x" } })).not.toThrow()
  })
})

describe("filterMatcher: review round 15", () => {
  // The offline WatermelonDB store holds a v.decimal128() field as its decimal string; on the
  // server the same field is a Decimal128. Round 14's type bracketing made { amount: { $gt: 10 } }
  // miss "12.50" offline, where it matched on the server: the same handler answered differently.
  it("numericStrings (the offline adapter's): a decimal string compares with a number by value", async () => {
    const { matches } = await import("@/runtime/filterMatcher")
    const offline = { numericStrings: true }
    expect(matches({ amount: "12.50" }, { amount: { $gt: 10 } }, offline)).toBe(true)
    expect(matches({ amount: "12.50" }, { amount: { $lte: 12.5 } }, offline)).toBe(true)
    expect(matches({ amount: "12.50" }, { amount: 12.5 }, offline)).toBe(true)
    expect(matches({ amount: "12.50" }, { amount: { $in: [12.5] } }, offline)).toBe(true)
    // …and nothing else loosens: null and booleans stay out of ranges, strings compare as strings.
    expect(matches({ amount: null }, { amount: { $lt: 10 } }, offline)).toBe(false)
    expect(matches({ amount: false }, { amount: { $gte: 0 } }, offline)).toBe(false)
    expect(matches({ code: "007" }, { code: "7" }, offline)).toBe(false)
    expect(matches({ name: "abc" }, { name: { $gt: 5 } }, offline)).toBe(false)
    // Without it (the shared stream, matching MongoDB): a string is not a number.
    expect(matches({ amount: "12.50" }, { amount: { $gt: 10 } })).toBe(false)
  })

  it("$gt / $lt null match nothing; $gte / $lte null match null or missing (MongoDB's)", async () => {
    const { matches } = await import("@/runtime/filterMatcher")
    expect(matches({ score: 5 }, { score: { $gt: null } })).toBe(false) // JavaScript: 5 > null
    expect(matches({ score: -5 }, { score: { $lt: null } })).toBe(false)
    expect(matches({ score: null }, { score: { $gte: null } })).toBe(true)
    expect(matches({}, { score: { $lte: null } })).toBe(true)
    expect(matches({ score: 0 }, { score: { $gte: null } })).toBe(false) // JavaScript: 0 >= null
  })
})

describe("filterMatcher: review round 16", () => {
  it("numericStrings as a set of paths loosens only those fields", async () => {
    const { matches } = await import("@/runtime/filterMatcher")
    const offline = { numericStrings: new Set(["amount", "lines.total"]) }
    expect(matches({ amount: "12.50" }, { amount: { $gt: 10 } }, offline)).toBe(true)
    expect(matches({ lines: [{ total: "7.5" }] }, { "lines.total": 7.5 }, offline)).toBe(true)
    expect(matches({ zip: "02134" }, { zip: 2134 }, offline)).toBe(false)
    expect(matches({ zip: "02134" }, { $or: [{ zip: 2134 }, { amount: { $gt: 100 } }] }, offline)).toBe(false)
  })

  it("decimal128Paths lists a schema's decimal fields, nested and in arrays", async () => {
    const { decimal128Paths } = await import("@/runtime/decimal")
    const { v } = await import("@/server/handlers")
    const shape = {
      amount: v.decimal128(),
      zip: v.string(),
      meta: v.object({ price: v.decimal128().optional() }),
      lines: v.array(v.object({ total: v.decimal128() })),
      rates: v.array(v.decimal128()),
    }
    expect(decimal128Paths(shape).sort()).toEqual(["amount", "lines.total", "meta.price", "rates"])
    expect(decimal128Paths(v.object(shape)).sort()).toEqual(["amount", "lines.total", "meta.price", "rates"])
    expect(decimal128Paths(undefined)).toEqual([])
  })
})

describe("filterMatcher: review round F3", () => {
  it("$options without $regex is not a filter the hub runs, and matches nothing (MongoDB refuses it)", async () => {
    const { unsupportedOperator, matches } = await import("@/runtime/filterMatcher")
    expect(unsupportedOperator({ name: { $options: "i" } })).toBe("$options")
    expect(matches({ name: "x" }, { name: { $options: "i" } })).toBe(false) // matched every row
  })

  it("a non-array $and / $or / $nor is MongoDB's error, not a TypeError (the offline adapter calls matches directly)", async () => {
    const { matches } = await import("@/runtime/filterMatcher")
    expect(() => matches({ a: 1 }, { $or: { a: 1 } } as any)).toThrow(/\$or must be an array/)
    expect(() => matches({ a: 1 }, { $and: "x" } as any)).toThrow(/\$and must be an array/)
  })
})

describe("filterMatcher: review round F6", () => {
  it("an empty $and / $or / $nor is MongoDB's error, not every row or none", async () => {
    const { matches, unsupportedOperator } = await import("@/runtime/filterMatcher")
    expect(() => matches({ a: 1 }, { $or: [] })).toThrow(/\$or must be a nonempty array/)
    expect(() => matches({ a: 1 }, { $and: [] })).toThrow(/\$and must be a nonempty array/)
    expect(unsupportedOperator({ $nor: [] })).toBe("$nor")
  })
})

describe("filterMatcher: review round F8", () => {
  it("two RegExps are equal only with the same source and flags (they have no keys to compare)", async () => {
    const { deepEqual, matches } = await import("@/runtime/filterMatcher")
    expect(deepEqual(/^a/, /^b/)).toBe(false)
    expect(deepEqual(/^a/i, /^a/)).toBe(false)
    expect(deepEqual(/^a/i, /^a/i)).toBe(true)
    expect(matches({ pattern: /^a/ }, { pattern: { $ne: /^b/ } } as any)).toBe(true) // was: every regex equal
  })
})
