// tests/unit/runtime/decimal.test.ts
import { describe, it, expect } from "vitest"
import z4 from "zod/v4"
import {
  decimal128,
  isDecimal128Schema,
  schemaHasDecimal128,
  encodeDecimal128,
  encodeDecimal128Patch,
  decodeDecimal128Deep,
} from "@/runtime/decimal"

// A stand-in for mongodb's Decimal128 so this module stays browser-safe.
// autoStamp injects the real one; here we duck-type the shape decode looks for.
class FakeDecimal {
  _bsontype = "Decimal128"
  constructor(public s: string) {}
  toString() {
    return this.s
  }
}
const make = (s: string) => new FakeDecimal(s)

describe("decimal128() validator", () => {
  it("accepts canonical decimal strings", () => {
    const s = decimal128()
    expect(s.safeParse("100.14").success).toBe(true)
    expect(s.safeParse("0").success).toBe(true)
    expect(s.safeParse("-3.5").success).toBe(true)
  })

  it("rejects non-decimal strings", () => {
    const s = decimal128()
    expect(s.safeParse("abc").success).toBe(false)
    expect(s.safeParse("1.2.3").success).toBe(false)
    expect(s.safeParse("").success).toBe(false)
  })
})

describe("isDecimal128Schema", () => {
  it("detects a bare branded schema", () => {
    expect(isDecimal128Schema(decimal128())).toBe(true)
  })

  it("detects through .optional()/.nullable() wrappers", () => {
    expect(isDecimal128Schema(decimal128().optional())).toBe(true)
    expect(isDecimal128Schema(decimal128().nullable())).toBe(true)
    expect(isDecimal128Schema(decimal128().optional().nullable())).toBe(true)
  })

  it("returns false for plain strings", () => {
    expect(isDecimal128Schema(z4.string())).toBe(false)
    expect(isDecimal128Schema(z4.string().optional())).toBe(false)
  })
})

describe("schemaHasDecimal128", () => {
  it("is true when a top-level field is decimal128", () => {
    const schema = z4.object({ amount: decimal128(), name: z4.string() })
    expect(schemaHasDecimal128(schema)).toBe(true)
  })

  it("is true for a nested-object decimal field", () => {
    const schema = z4.object({ fee: z4.object({ rate: decimal128().optional() }) })
    expect(schemaHasDecimal128(schema)).toBe(true)
  })

  it("is true for an array-of-decimal field", () => {
    const schema = z4.object({ amounts: z4.array(decimal128()) })
    expect(schemaHasDecimal128(schema)).toBe(true)
  })

  it("is false when no field is decimal128", () => {
    const schema = z4.object({ name: z4.string(), n: z4.number() })
    expect(schemaHasDecimal128(schema)).toBe(false)
  })
})

describe("encodeDecimal128 (schema-guided write)", () => {
  it("converts a top-level decimal string to Decimal128", () => {
    const schema = z4.object({ amount: decimal128(), name: z4.string() })
    const out = encodeDecimal128(schema, { amount: "100.14", name: "x" }, make)
    expect(out.amount).toBeInstanceOf(FakeDecimal)
    expect(out.amount.toString()).toBe("100.14")
    expect(out.name).toBe("x")
  })

  it("recurses into nested objects and arrays", () => {
    const schema = z4.object({
      fee: z4.object({ rate: decimal128() }),
      tiers: z4.array(z4.object({ cut: decimal128() })),
    })
    const out = encodeDecimal128(
      schema,
      { fee: { rate: "0.0035" }, tiers: [{ cut: "1.50" }, { cut: "2.00" }] },
      make
    )
    expect(out.fee.rate.toString()).toBe("0.0035")
    expect(out.tiers[0].cut.toString()).toBe("1.50")
    expect(out.tiers[1].cut.toString()).toBe("2.00")
  })

  it("leaves null/undefined decimal fields untouched", () => {
    const schema = z4.object({ amount: decimal128().nullable() })
    expect(encodeDecimal128(schema, { amount: null }, make).amount).toBeNull()
    expect(encodeDecimal128(schema, {}, make).amount).toBeUndefined()
  })

  it("is idempotent — already-Decimal128 values pass through", () => {
    const schema = z4.object({ amount: decimal128() })
    const d = make("9.99")
    const out = encodeDecimal128(schema, { amount: d }, make)
    expect(out.amount).toBe(d)
  })
})

describe("encodeDecimal128Patch ($set / $setOnInsert)", () => {
  const schema = z4.object({
    amount: decimal128(),
    fee: z4.object({ rate: decimal128() }),
    name: z4.string(),
  })

  it("encodes nested-object patch values", () => {
    const out = encodeDecimal128Patch(schema, { amount: "5.00", name: "y" }, make)
    expect(out.amount.toString()).toBe("5.00")
    expect(out.name).toBe("y")
  })

  it("encodes dotted-path keys", () => {
    const out = encodeDecimal128Patch(schema, { "fee.rate": "0.10" }, make)
    expect(out["fee.rate"].toString()).toBe("0.10")
  })

  it("leaves non-decimal dotted keys alone", () => {
    const out = encodeDecimal128Patch(schema, { "name": "z" }, make)
    expect(out.name).toBe("z")
  })
})

describe("decodeDecimal128Deep (schema-agnostic read)", () => {
  it("converts Decimal128 to string at any depth", () => {
    const input = {
      amount: make("100.14"),
      fee: { rate: make("0.0035") },
      rows: [{ cut: make("1.50") }],
      name: "keep",
      n: 3,
    }
    const out = decodeDecimal128Deep(input)
    expect(out.amount).toBe("100.14")
    expect(out.fee.rate).toBe("0.0035")
    expect(out.rows[0].cut).toBe("1.50")
    expect(out.name).toBe("keep")
    expect(out.n).toBe(3)
  })

  it("handles arrays at the top level", () => {
    const out = decodeDecimal128Deep([{ a: make("1.00") }, { a: make("2.00") }])
    expect(out[0].a).toBe("1.00")
    expect(out[1].a).toBe("2.00")
  })

  it("passes through null and non-decimal values", () => {
    expect(decodeDecimal128Deep(null)).toBeNull()
    expect(decodeDecimal128Deep("x")).toBe("x")
    const dt = new Date()
    expect(decodeDecimal128Deep(dt)).toBe(dt)
  })
})
