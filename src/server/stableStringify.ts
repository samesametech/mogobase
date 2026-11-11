// Deterministic JSON. Used to build cache keys — refetchScheduler slots, and the live-query
// watch keys that decide whether a re-run's watch is the one already open — so two values
// that are equal give the same string regardless of property iteration order.
//
// A value JSON has no form for prints as a typed token — `Date("…")`, `ObjectId("…")`,
// `Map[…]` — which no plain value can print as (a plain object starts with "{", a string with
// a quote). Typed values used to print as `{"$date":…}`, exactly what the plain object
// `{ $date: … }` printed, so the two shared a key.

import { isPlainDocument } from "@/runtime/plainDocument"

//
// `sortKeys: false` keeps each object's key order, for keys of MongoDB filters: equality on an
// embedded document is order-sensitive ({ zip, city } is not { city, zip }), so two filters
// differing only there must not share a key. Sorted, a server-filtered stream kept only the first
// of them in its $match, and a watch whose filter changed only in that order stayed the old one.
export function stableStringify(value: any, sortKeys = true): string {
  const inner = (v: any) => stableStringify(v, sortKeys)
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return String(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return "[" + value.map(inner).join(",") + "]"
  }
  // BSON values and Dates have no own enumerable keys, so the object branch below printed every
  // one of them as "{}": two watches on different ObjectIds would have shared a key, and the
  // second would never have opened.
  if (value instanceof Date) return `Date(${JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString())})`
  if (value instanceof RegExp) return `RegExp(${JSON.stringify(value.source)},${JSON.stringify(value.flags)})`
  // Typed, like the BSON values below: as a bare number a bigint printed the same as the equal
  // number, so a row keyed 5n and an id of 5 shared a key.
  if (typeof value === "bigint") return `BigInt(${value.toString()})`
  // A Map or Set has no own enumerable keys either, so every one printed as "{}". By content,
  // in a stable order: equal ones print alike whatever order they were filled in.
  if (value instanceof Map) {
    const entries = [...value].map(([k, v]) => [inner(k), inner(v)])
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `Map[${entries.map(([k, v]) => `[${k},${v}]`).join(",")}]`
  }
  if (value instanceof Set) return `Set[${[...value].map(inner).sort().join(",")}]`
  if (typeof value === "object" && typeof value._bsontype === "string") {
    const type = value._bsontype
    // Binary (UUID included) by its bytes and subtype. Its String() decodes the bytes as UTF-8,
    // so two values whose bytes are not valid UTF-8 could print the same.
    if (type === "Binary" && typeof value.toString === "function") {
      return `Binary(${JSON.stringify(value.toString("base64"))},${Number(value.sub_type)})`
    }
    if (typeof value.toHexString === "function") return `${type}(${JSON.stringify(value.toHexString())})`
    // Code, Timestamp, Decimal128, Long, …: their JSON form carries every field (a Code's
    // String() is "[object Object]", whatever its code).
    if (typeof value.toJSON === "function") return `${type}(${inner(value.toJSON())})`
    // No JSON form (BSONRegExp, MinKey, MaxKey): by its own fields — a BSONRegExp's pattern and
    // options. String() would print "[object Object]" for every one of them.
    const fields: Record<string, unknown> = {}
    for (const key of Object.keys(value)) fields[key] = value[key]
    return `${type}(${inner(fields)})`
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined)
    if (sortKeys) keys.sort()
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + inner(value[k])).join(",") + "}"
  }
  return JSON.stringify(value)
}

/**
 * A MongoDB filter's key: equal for filters that mean the same, different for filters that do
 * not. Its conditions are ANDed, and an operator object means the same in any order, so those are
 * sorted ({ a: 1, b: 2 } is { b: 2, a: 1 }); but a value compared by equality — an embedded
 * document, `$eq`, `$in` — keeps its key order, since MongoDB matches an embedded document only
 * with its fields in the same order ({ addr: { zip, city } } is not { addr: { city, zip } }).
 * Fully sorted, those two shared a key: a server-filtered stream kept only the first in its $match,
 * and a watch whose filter changed only there stayed the old one. A pipeline: its $match stages
 * as filters, any other stage as written.
 */
export function filterKey(filter: unknown): string {
  if (Array.isArray(filter)) {
    return "[" + filter.map((stage) => (isPlainDocument(stage) && Object.keys(stage).length === 1 && "$match" in stage ? `{"$match":${filterKey(stage.$match)}}` : stableStringify(stage, false))).join(",") + "]"
  }
  if (!isPlainDocument(filter)) return stableStringify(filter, false)
  const keys = Object.keys(filter).filter((k) => filter[k] !== undefined).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + conditionKey(k, filter[k])).join(",") + "}"
}

function conditionKey(key: string, value: unknown): string {
  if (key === "$and" || key === "$or" || key === "$nor") {
    return Array.isArray(value) ? "[" + value.map(filterKey).join(",") + "]" : stableStringify(value, false)
  }
  if (key === "$not") return isPlainDocument(value) ? filterKey(value) : stableStringify(value, false)
  if (key.startsWith("$")) return stableStringify(value, false) // $expr, $where, $text…: as written
  return fieldConditionKey(value)
}

// $in / $nin / $all are sets: their members in a stable order (a list built in a different order
// on each run — an unsorted find, a Set — gave a new key every re-run: the watch reopened and a
// catch-up run followed each write); each member, a value compared by equality, keeps its own
// key order.
const SET_OPERATORS = new Set(["$in", "$nin", "$all"])

function operandKey(op: string, operand: unknown): string {
  if (op === "$elemMatch") return filterKey(operand)
  if (op === "$not") return fieldConditionKey(operand)
  if (SET_OPERATORS.has(op) && Array.isArray(operand)) return "[" + operand.map((member) => stableStringify(member, false)).sort().join(",") + "]"
  return stableStringify(operand, false)
}

function fieldConditionKey(value: unknown): string {
  if (isPlainDocument(value) && Object.keys(value).some((k) => k.startsWith("$"))) {
    const ops = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return "{" + ops.map((op) => JSON.stringify(op) + ":" + operandKey(op, value[op])).join(",") + "}"
  }
  return stableStringify(value, false) // compared by equality: an embedded document in its own order
}
