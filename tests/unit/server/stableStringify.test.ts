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
