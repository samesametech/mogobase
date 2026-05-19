// Decimal128 support — browser-safe. NO `mongodb` import is reachable here
// (this module is consumed transitively by mogobase/runtime, which the
// offline-path hooks bundle for the browser). The actual BSON Decimal128
// constructor is injected by the server-side autoStamp wrapper via the
// `make` callback; everything in this file is pure schema/value walking.
//
// Storage model: a `v.decimal128()` field is carried as a canonical decimal
// STRING on the wire and in handler code ("100.14"), and persisted as a BSON
// Decimal128 in MongoDB. Storing the real numeric BSON type (rather than a
// string) is what lets number-operand filters and `$gt`/`$sum`/`$avg` work
// server-side without lexicographic-string surprises. The autoStamp wrapper
// encodes string→Decimal128 on writes (schema-guided) and decodes
// Decimal128→string on reads (schema-agnostic deep walk).

import { z } from "zod/v4"

// Stable cross-realm brand. `Symbol.for` so a schema branded in one module
// instance is still recognized if zod/this module is duplicated in a bundle.
export const DECIMAL128_BRAND = Symbol.for("mogobase.decimal128")

// Canonical decimal string: optional leading `-`, digits, optional fraction.
// No exponent form (BSON Decimal128 stores it; we keep the wire form plain).
const DECIMAL_RE = /^-?\d+(\.\d+)?$/

// A branded zod string validating a canonical decimal string. The brand is
// attached to the returned instance; `.optional()`/`.nullable()` wrap it
// without copying the inner instance, so the brand survives (see
// `isDecimal128Schema`, which unwraps `_def.innerType`).
export function decimal128() {
  const schema = z.string().regex(DECIMAL_RE, 'Expected a decimal string, e.g. "100.14"')
  ;(schema as any)[DECIMAL128_BRAND] = true
  return schema
}

// Unwrap optional/nullable/default/etc. wrappers to the innermost schema.
function unwrap(schema: any): any {
  let cur = schema
  while (cur && cur._def && cur._def.innerType) cur = cur._def.innerType
  return cur
}

export function isDecimal128Schema(schema: any): boolean {
  if (!schema) return false
  if (schema[DECIMAL128_BRAND] === true) return true
  const inner = unwrap(schema)
  return !!inner && inner[DECIMAL128_BRAND] === true
}

// ZodObject exposes `.shape`; ZodArray exposes `_def.element`. Both may sit
// behind optional/nullable wrappers, so unwrap before inspecting.
function objectShape(schema: any): Record<string, any> | undefined {
  const s = unwrap(schema)
  return s && typeof s.shape === "object" ? s.shape : undefined
}
function arrayElement(schema: any): any {
  const s = unwrap(schema)
  return s && s._def ? s._def.element : undefined
}

// True if the schema declares at least one decimal128 field anywhere. Used by
// autoStamp to skip the read-decode walk entirely for decimal-free models.
export function schemaHasDecimal128(schema: any): boolean {
  if (!schema) return false
  if (isDecimal128Schema(schema)) return true
  const shape = objectShape(schema)
  if (shape) {
    for (const k of Object.keys(shape)) {
      if (schemaHasDecimal128(shape[k])) return true
    }
    return false
  }
  const el = arrayElement(schema)
  if (el) return schemaHasDecimal128(el)
  return false
}

type Make = (s: string) => any

function isDecimalValue(v: any): boolean {
  return !!v && typeof v === "object" && (v as any)._bsontype === "Decimal128"
}

function makeDecimal(v: any, make: Make): any {
  if (v == null) return v
  if (isDecimalValue(v)) return v // idempotent
  return make(typeof v === "string" ? v : String(v))
}

// Schema-guided write encode. Walks the schema alongside the value and
// converts declared decimal128 fields string→Decimal128. Non-decimal fields
// are passed through untouched. Objects/arrays are shallow-cloned only when a
// nested value changes is not tracked — we clone defensively so callers' input
// is never mutated.
export function encodeDecimal128(schema: any, value: any, make: Make): any {
  if (value == null || !schema) return value
  if (isDecimal128Schema(schema)) return makeDecimal(value, make)

  const shape = objectShape(schema)
  if (shape && typeof value === "object" && !Array.isArray(value)) {
    const out: any = { ...value }
    for (const k of Object.keys(shape)) {
      if (k in out) out[k] = encodeDecimal128(shape[k], out[k], make)
    }
    return out
  }

  const el = arrayElement(schema)
  if (el && Array.isArray(value)) {
    return value.map((item) => encodeDecimal128(el, item, make))
  }

  return value
}

// Resolve a dotted path ("fee.rate") through the schema and report whether it
// terminates at a decimal128 field. Used for `$set: { "fee.rate": "0.1" }`.
function isDecimal128AtPath(schema: any, path: string): boolean {
  const parts = path.split(".")
  let cur: any = schema
  for (const part of parts) {
    if (!cur) return false
    // Numeric segment of a dotted path → array index; descend into element.
    if (/^\d+$/.test(part)) {
      cur = arrayElement(cur)
      continue
    }
    const shape = objectShape(cur)
    if (!shape || !(part in shape)) return false
    cur = shape[part]
  }
  return isDecimal128Schema(cur)
}

// Resolve a dotted path to the field schema (for non-decimal nested encode).
function schemaAtPath(schema: any, path: string): any {
  const parts = path.split(".")
  let cur: any = schema
  for (const part of parts) {
    if (!cur) return undefined
    if (/^\d+$/.test(part)) {
      cur = arrayElement(cur)
      continue
    }
    const shape = objectShape(cur)
    if (!shape || !(part in shape)) return undefined
    cur = shape[part]
  }
  return cur
}

// Encode a `$set` / `$setOnInsert` patch object. Keys may be plain field
// names (recurse via the field schema) or dotted paths (resolve through the
// schema, then encode the leaf).
export function encodeDecimal128Patch(schema: any, patch: any, make: Make): any {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !schema) return patch
  const out: any = { ...patch }
  for (const key of Object.keys(out)) {
    if (key.includes(".")) {
      if (isDecimal128AtPath(schema, key)) {
        out[key] = makeDecimal(out[key], make)
      } else {
        const sub = schemaAtPath(schema, key)
        if (sub) out[key] = encodeDecimal128(sub, out[key], make)
      }
      continue
    }
    const shape = objectShape(schema)
    if (shape && key in shape) {
      out[key] = encodeDecimal128(shape[key], out[key], make)
    }
  }
  return out
}

// Schema-agnostic read decode. Deeply walks any value and converts every BSON
// Decimal128 to its canonical decimal string. Schema-free on purpose: it must
// also cover `aggregate` output whose shape isn't statically known. Native
// BSON/host objects (Date, ObjectId, Binary, …) are passed through — only
// plain objects and arrays are recursed.
export function decodeDecimal128Deep(value: any): any {
  if (value == null) return value
  if (isDecimalValue(value)) return value.toString()
  if (Array.isArray(value)) return value.map((v) => decodeDecimal128Deep(v))
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value)
    // Only recurse plain objects ({} / Object.create(null)). Anything with a
    // custom prototype (Date, ObjectId, Decimal128 handled above, class
    // instances) is returned as-is.
    if (proto === Object.prototype || proto === null) {
      const out: any = {}
      for (const k of Object.keys(value)) out[k] = decodeDecimal128Deep(value[k])
      return out
    }
  }
  return value
}
