// src/runtime/filterMatcher.ts
//
// JS-side Mongo filter matcher. Single source of truth for filter evaluation
// outside of MongoDB. Used by:
//   - WatermelonDB adapter (offline-mode handler queries against decoded blobs)
//   - server/streamHub (post-change-stream filter evaluation per subscriber)
//
// Supported operators: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex
// $and $or $nor $not, with MongoDB's array semantics, dotted paths through
// arrays, RegExp values and numbers compared across BSON types (see
// matchesValues). Unsupported: $expr $where $elemMatch $text — isSupportedFilter()
// returns false for these so callers can route to the legacy MongoDB-pipeline
// path or surface a clear error.

import { isDecimalString } from "./decimal"
import { isPlainDocument } from "./plainDocument"

export type MongoFilter = Record<string, any>

const SCALAR_OPS = new Set([
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin",
  "$exists", "$regex", "$options",
])
// $nor too: toServerMatch writes a logical $not as $nor, and a $nor the matcher rejected sent
// its watch to a change stream per subscriber.
const TOP_OPS = new Set(["$and", "$or", "$nor", "$not"])
const UNSUPPORTED_OPS = new Set(["$expr", "$where", "$elemMatch", "$text", "$mod", "$all", "$size", "$type"])

export type MatchOptions = {
  /**
   * Compare a canonical decimal string ("12.50") with a number by value, in ranges and equality —
   * in the fields named (dotted paths, as the filter writes them), or in every field with `true`.
   * For the offline WatermelonDB adapter, whose store holds a `v.decimal128()` field as that
   * string where the server holds a Decimal128: without it, `{ amount: { $gt: 10 } }` matched on
   * the server and missed the row offline. It passes its model's decimal fields
   * (decimal128Paths): loosened everywhere, `{ zip: 2134 }` found "02134", which MongoDB never
   * does. Off for the shared stream, which matches MongoDB's change events (a string there is a
   * string). A string compared with a string is always text.
   */
  numericStrings?: boolean | ReadonlySet<string>
}

const looseAt = (key: string, options?: MatchOptions): boolean => {
  const fields = options?.numericStrings
  return fields === true || (typeof fields === "object" && fields !== null && fields.has(key))
}

export function matches(doc: any, filter: MongoFilter, options?: MatchOptions): boolean {
  if (!filter || typeof filter !== "object") return true
  for (const [key, cond] of Object.entries(filter)) {
    if ((key === "$and" || key === "$or" || key === "$nor") && (!Array.isArray(cond) || cond.length === 0)) {
      // MongoDB's own error: `.every` on an object was a TypeError, and an empty list matched every
      // row ($and) or none ($or) where MongoDB refuses it (the offline adapter calls this directly;
      // the hub never gets such a filter — unsupportedOperator sends it elsewhere).
      throw new Error(Array.isArray(cond) ? `${key} must be a nonempty array` : `${key} must be an array`)
    }
    if (key === "$and") {
      if (!(cond as any[]).every((c) => matches(doc, c, options))) return false
      continue
    }
    if (key === "$or") {
      if (!(cond as any[]).some((c) => matches(doc, c, options))) return false
      continue
    }
    if (key === "$nor") {
      if ((cond as any[]).some((c) => matches(doc, c, options))) return false
      continue
    }
    if (key === "$not") {
      if (matches(doc, cond, options)) return false
      continue
    }
    if (!matchesValues(pathValues(doc, key), cond, looseAt(key, options))) return false
  }
  return true
}

/** Whether one value meets a field's condition — MongoDB's way: an array meets it when it, or any of its elements, does. */
// One value, no path: numericStrings is a yes or no here (a set of paths has nothing to name).
export function matchesValue(val: any, cond: any, options?: { numericStrings?: boolean }): boolean {
  return matchesValues([val], cond, options?.numericStrings === true)
}

// MongoDB's semantics, which the shared stream's subscribers are matched by — with server-side
// filters MongoDB has already matched each event, and a JS re-check that disagreed dropped it:
//   - a field holding an array meets a condition when the array, or any element of it, does
//     (`{ tags: "x" }` matches `tags: ["x", "y"]`), each operator on its own (`$gt` and `$lt`
//     may be met by different elements — `$elemMatch` is the one that ties them, and routes to
//     a stream of its own); `$ne`/`$nin` hold when no value is equal / in the list;
//   - a dotted path runs through arrays of documents (`items.sku` reads every item's sku), and a
//     numeric segment indexes one (`items.0.sku`);
//   - a RegExp value is a regex match, in a field or in `$in`; `$options` applies to a
//     `$regex` given as a RegExp too (its flags and the options together);
//   - numbers compare by value across number, Decimal128, Long, Int32, Double and bigint;
//   - `$gt`/`$gte`/`$lt`/`$lte` compare within one type (MongoDB's type bracketing): null,
//     "25" and false are not below 10, where JavaScript's coercing `<` said they were.
function matchesValues(vals: any[], cond: any, loose = false): boolean {
  // The values at the path, plus the elements of each array among them. A single plain value —
  // the common case, per subscriber per change — is used as the list it came in: no flattened
  // copy (pathValues' one-element list is the only allocation).
  const flat = vals.length === 1 && !Array.isArray(vals[0])
  const cands = flat ? vals : vals.flatMap((v) => (Array.isArray(v) ? [v, ...v] : [v]))
  if (cond instanceof RegExp) return cands.some((c) => regexMatches(cond, c))
  if (cond === null || typeof cond !== "object" || Array.isArray(cond) || cond instanceof Date) {
    return cands.some((c) => equals(c, cond, loose))
  }
  const ops = Object.keys(cond)
  if (!ops.some((k) => k.startsWith("$"))) return cands.some((c) => documentEquals(c, cond))
  // Ordering compares an array operand with arrays, anything else with the elements.
  const ordered = (target: any) =>
    flat || Array.isArray(target) ? cands : vals.flatMap((v) => (Array.isArray(v) ? v : [v]))
  for (const op of ops) {
    const target = cond[op]
    switch (op) {
      case "$eq":
        if (!cands.some((c) => equals(c, target, loose))) return false
        break
      case "$ne":
        if (cands.some((c) => equals(c, target, loose))) return false
        break
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte":
        if (!ordered(target).some((c) => relates(c, target, op, loose))) return false
        break
      case "$in":
        if (!Array.isArray(target) || !target.some((t) => cands.some((c) => inMatches(c, t, loose)))) return false
        break
      case "$nin":
        if (Array.isArray(target) && target.some((t) => cands.some((c) => inMatches(c, t, loose)))) return false
        break
      case "$exists":
        if (target && vals.every((v) => v === undefined)) return false
        if (!target && vals.some((v) => v !== undefined)) return false
        break
      case "$regex": {
        // Compiled once per condition object (a subscriber's filter lives as long as it does).
        // One JavaScript cannot compile matches nothing here — unsupportedOperator sends such a
        // filter to a stream of its own, where MongoDB runs it.
        const re = regexOf(cond)
        if (!re || !cands.some((c) => regexMatches(re, c))) return false
        break
      }
      case "$options":
        if (!("$regex" in cond)) return false // MongoDB refuses $options without $regex
        break
      default:
        // Unknown operator — be tolerant at evaluation time. Callers that
        // want fail-fast behavior should pre-check with isSupportedFilter.
        return false
    }
  }
  return true
}

function equals(val: any, target: any, loose = false): boolean {
  if (target === null) return val === null || val === undefined
  if (loose) {
    const order = compareDecimalString(val, target)
    if (order !== undefined) return order === 0
  }
  return documentEquals(val, target)
}

// Equality as MongoDB's query does it: an embedded document equals another only with the same
// fields IN THE SAME ORDER ({ zip, city } is not { city, zip }); arrays element by element; any
// other value as deepEqual (numbers across BSON types, Dates, ObjectIds by value). deepEqual
// itself — exported, order-blind — is left as it is.
function documentEquals(a: any, b: any): boolean {
  if (isPlainDocument(a) && isPlainDocument(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((key, i) => key === kb[i] && documentEquals(a[key], b[key]))
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => documentEquals(item, b[i]))
  return deepEqual(a, b)
}

const inMatches = (val: any, target: any, loose = false): boolean =>
  target instanceof RegExp ? regexMatches(target, val) : equals(val, target, loose)

// A canonical decimal string against a number (or BSON number): -1, 0 or 1, by value. Anything
// else — two strings included — undefined.
function compareDecimalString(a: any, b: any): number | undefined {
  const aString = isDecimalString(a)
  const bString = isDecimalString(b)
  if (aString === bString) return undefined
  const x = aString ? a : numericText(a)
  const y = bString ? b : numericText(b)
  return x === undefined || y === undefined ? undefined : compareDecimalText(x, y)
}

function regexMatches(re: RegExp, val: any): boolean {
  if (typeof val !== "string") return false
  re.lastIndex = 0 // a /g or /y regex keeps its position between tests
  return re.test(val)
}

// Keyed by the condition object, checked against its current $regex / $options (a filter
// object reused with a different pattern compiles again).
const compiledRegex = new WeakMap<object, { pattern: unknown; options: unknown; re: RegExp | null }>()

function regexOf(cond: any): RegExp | null {
  const hit = compiledRegex.get(cond)
  if (hit && hit.pattern === cond.$regex && hit.options === cond.$options) return hit.re
  const re = compileRegex(cond.$regex, cond.$options)
  compiledRegex.set(cond, { pattern: cond.$regex, options: cond.$options, re })
  return re
}

/**
 * A `$regex` (string or RegExp) with its `$options`, as a JavaScript RegExp — or null when
 * JavaScript cannot run it: MongoDB's `x` flag (extended), or PCRE syntax such as `(?i)`.
 * `new RegExp` used to throw on those, from inside the shared stream's change listener.
 */
export function compileRegex(pattern: unknown, options: unknown): RegExp | null {
  const source = pattern instanceof RegExp ? pattern.source : typeof pattern === "string" ? pattern : undefined
  if (source === undefined) return null
  const flags = [...new Set((pattern instanceof RegExp ? pattern.flags : "") + (typeof options === "string" ? options : ""))].join("")
  if (/[^dgimsuy]/.test(flags)) return null
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

// The type a value is ordered within, for the types `$gt` and the rest compare; undefined for
// any other (left to JavaScript's comparison, as before).
function bracketOf(v: any): string | undefined {
  if (typeof v === "number" || typeof v === "bigint") return "number"
  if (typeof v === "string") return "string"
  if (typeof v === "boolean") return "boolean"
  if (v instanceof Date) return "date"
  const type = v?._bsontype
  if (type === "Decimal128" || type === "Long" || type === "Int32" || type === "Double") return "number"
  if (type === "ObjectId") return "objectId"
  return undefined
}

function relates(val: any, target: any, op: "$gt" | "$gte" | "$lt" | "$lte", loose = false): boolean {
  // null sorts alone: $gte / $lte null match null (or missing), $gt / $lt null nothing.
  // JavaScript's 5 > null and 0 >= null were true.
  if (target === null) return (op === "$gte" || op === "$lte") && (val === null || val === undefined)
  const order = (loose ? compareDecimalString(val, target) : undefined) ?? orderWithin(val, target)
  if (order === null) return false
  if (order === undefined) {
    // Two values of one type that are not a BSON number: JavaScript's comparison, as before.
    if (op === "$gt") return val > target
    if (op === "$gte") return val >= target
    if (op === "$lt") return val < target
    return val <= target
  }
  if (op === "$gt") return order > 0
  if (op === "$gte") return order >= 0
  if (op === "$lt") return order < 0
  return order <= 0
}

// null when the two are of different types (MongoDB compares within one); a number when both are
// numbers and one is a BSON number; undefined to leave it to JavaScript.
function orderWithin(val: any, target: any): number | null | undefined {
  const bracket = bracketOf(target)
  if (bracket !== undefined && bracketOf(val) !== bracket) return null
  return compareNumbers(val, target)
}

/**
 * The values at a dotted path, MongoDB's way: through an array of documents the path continues
 * in each of them, and a numeric segment also indexes the array. `[undefined]` when none.
 */
function pathValues(obj: any, path: string): any[] {
  if (!path.includes(".")) return [obj?.[path]]
  const out: any[] = []
  collect(obj, path.split("."), 0, out)
  return out.length ? out : [undefined]
}

function collect(obj: any, segments: string[], i: number, out: any[]): void {
  if (i === segments.length) {
    out.push(obj)
    return
  }
  if (obj == null || typeof obj !== "object") return
  const key = segments[i]
  if (!Array.isArray(obj)) {
    collect(obj[key], segments, i + 1, out)
    return
  }
  if (/^\d+$/.test(key)) collect(obj[Number(key)], segments, i + 1, out)
  for (const el of obj) if (el && typeof el === "object" && !Array.isArray(el)) collect(el, segments, i, out)
}

export function getPath(obj: any, path: string): any {
  if (!path.includes(".")) return obj?.[path]
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj)
}

// A number's exact decimal text, for the numeric types MongoDB compares by value. Two plain
// numbers are left to JavaScript (undefined).
function numericText(v: any): string | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined
  if (typeof v === "bigint") return v.toString()
  const type = v?._bsontype
  if (type === "Decimal128" || type === "Long") return String(v.toString())
  if (type === "Int32" || type === "Double") return numericText(Number(v.valueOf()))
  return undefined
}

/** -1, 0 or 1 when both are numbers and one is a BSON number (or bigint); else undefined. */
function compareNumbers(a: any, b: any): number | undefined {
  if (typeof a === "number" && typeof b === "number") return undefined
  const x = numericText(a)
  const y = numericText(b)
  if (x === undefined || y === undefined) return undefined
  return compareDecimalText(x, y)
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

// Compares two decimal numerals exactly (no float rounding: Decimal128 holds 34 digits, Long 19).
// A non-numeral (NaN, Infinity) gives undefined.
function compareDecimalText(x: string, y: string): number | undefined {
  const a = decimalParts(x)
  const b = decimalParts(y)
  if (!a || !b) return undefined
  if (a.sign !== b.sign) return Math.sign(a.sign - b.sign)
  if (a.sign === 0) return 0
  const magnitude = a.digits.length + a.exp - (b.digits.length + b.exp)
  if (magnitude !== 0) return Math.sign(magnitude) * a.sign
  const width = Math.max(a.digits.length, b.digits.length)
  const da = a.digits.padEnd(width, "0")
  const db = b.digits.padEnd(width, "0")
  return da === db ? 0 : (da > db ? 1 : -1) * a.sign
}

// sign × digits × 10^exp, digits without leading or trailing zeros ("" for zero, sign 0).
function decimalParts(text: string): { sign: number; digits: string; exp: number } | undefined {
  const m = DECIMAL.exec(text)
  if (!m || (m[2] === "" && !m[3])) return undefined
  const frac = m[3] ?? ""
  let digits = (m[2] + frac).replace(/^0+/, "")
  let exp = Number(m[4] ?? 0) - frac.length
  if (!digits) return { sign: 0, digits: "", exp: 0 }
  const trimmed = digits.replace(/0+$/, "")
  exp += digits.length - trimmed.length
  digits = trimmed
  return { sign: m[1] === "-" ? -1 : 1, digits, exp }
}

export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  // Numbers by value across BSON types: Decimal128("5.0") is 5, and Decimal128("1.0") is Decimal128("1.00").
  const order = compareNumbers(a, b)
  if (order !== undefined) return order === 0
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return false
  // Dates and BSON values (ObjectId, Decimal128, …) have no own enumerable keys, so compared by
  // their keys any two of them were equal: { day: someDate } matched every change with a date,
  // and { ownerId: someObjectId } every change with an ObjectId — another tenant's included.
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  // A RegExp has no own keys either: compared by them, every regex equalled every other.
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags
  }
  if (typeof a._bsontype === "string" || typeof b._bsontype === "string") {
    if (a._bsontype !== b._bsontype) return false
    if (typeof a.equals === "function") return !!a.equals(b)
    return JSON.stringify(a.toJSON?.() ?? a) === JSON.stringify(b.toJSON?.() ?? b)
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}

// Pre-flight check for callers that want to fail fast rather than silently
// drop matches at evaluation time. Returns false if any unsupported operator
// appears anywhere in the filter tree.
export function isSupportedFilter(filter: MongoFilter | undefined | null): boolean {
  return unsupportedOperator(filter) === undefined
}

/** The first operator in `filter` the JS matcher cannot evaluate (e.g. "$elemMatch"), if any. */
export function unsupportedOperator(filter: MongoFilter | undefined | null): string | undefined {
  if (filter == null) return undefined
  if (typeof filter !== "object") return undefined
  for (const [key, cond] of Object.entries(filter)) {
    if (UNSUPPORTED_OPS.has(key)) return key
    if (key === "$and" || key === "$or" || key === "$nor") {
      if (!Array.isArray(cond) || cond.length === 0) return key // MongoDB refuses both
      for (const sub of cond) {
        const op = unsupportedOperator(sub)
        if (op) return op
      }
      continue
    }
    if (key === "$not") {
      const op = unsupportedOperator(cond as MongoFilter)
      if (op) return op
      continue
    }
    if (key.startsWith("$")) {
      // Top-level unrecognized operator
      if (!TOP_OPS.has(key)) return key
      continue
    }
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      for (const op of Object.keys(cond)) {
        if (op.startsWith("$") && !SCALAR_OPS.has(op)) return op
        if (UNSUPPORTED_OPS.has(op)) return op
        // A pattern or option only MongoDB runs (`x`, `(?i)`): MongoDB's to evaluate.
        if (op === "$regex" && compileRegex(cond.$regex, cond.$options) === null) return op
        // $options with no $regex: MongoDB refuses the filter; matched here it matched every value.
        if (op === "$options" && !("$regex" in cond)) return op
      }
    }
  }
  return undefined
}

/** Two decimal strings by value (-1, 0, 1); undefined unless both are. For sorting a decimal field. */
export function compareDecimalStrings(a: unknown, b: unknown): number | undefined {
  return isDecimalString(a) && isDecimalString(b) ? compareDecimalText(a, b) : undefined
}
