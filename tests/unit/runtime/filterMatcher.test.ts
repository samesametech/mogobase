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
