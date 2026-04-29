// src/runtime/filterMatcher.ts
//
// JS-side Mongo filter matcher. Single source of truth for filter evaluation
// outside of MongoDB. Used by:
//   - WatermelonDB adapter (offline-mode handler queries against decoded blobs)
//   - server/streamHub (post-change-stream filter evaluation per subscriber)
//
// Supported operators: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex
// $and $or $not. Dotted paths via getPath. Unsupported: $expr $where
// $elemMatch $text — isSupportedFilter() returns false for these so callers
// can route to the legacy MongoDB-pipeline path or surface a clear error.

export type MongoFilter = Record<string, any>

const SCALAR_OPS = new Set([
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin",
  "$exists", "$regex", "$options",
])
const TOP_OPS = new Set(["$and", "$or", "$not"])
const UNSUPPORTED_OPS = new Set(["$expr", "$where", "$elemMatch", "$text", "$mod", "$all", "$size", "$type"])

export function matches(doc: any, filter: MongoFilter): boolean {
  if (!filter || typeof filter !== "object") return true
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$and") {
      if (!(cond as any[]).every((c) => matches(doc, c))) return false
      continue
    }
    if (key === "$or") {
      if (!(cond as any[]).some((c) => matches(doc, c))) return false
      continue
    }
    if (key === "$not") {
      if (matches(doc, cond)) return false
      continue
    }
    const val = getPath(doc, key)
    if (!matchesValue(val, cond)) return false
  }
  return true
}

export function matchesValue(val: any, cond: any): boolean {
  if (cond === null) return val === null || val === undefined
  if (typeof cond !== "object" || Array.isArray(cond) || cond instanceof Date) {
    return deepEqual(val, cond)
  }
  const ops = Object.keys(cond)
  if (!ops.some((k) => k.startsWith("$"))) return deepEqual(val, cond)
  for (const op of ops) {
    const target = cond[op]
    switch (op) {
      case "$eq":
        if (!deepEqual(val, target)) return false
        break
      case "$ne":
        if (deepEqual(val, target)) return false
        break
      case "$gt":
        if (!(val > target)) return false
        break
      case "$gte":
        if (!(val >= target)) return false
        break
      case "$lt":
        if (!(val < target)) return false
        break
      case "$lte":
        if (!(val <= target)) return false
        break
      case "$in":
        if (!Array.isArray(target) || !target.some((t) => deepEqual(val, t))) return false
        break
      case "$nin":
        if (Array.isArray(target) && target.some((t) => deepEqual(val, t))) return false
        break
      case "$exists":
        if (target && val === undefined) return false
        if (!target && val !== undefined) return false
        break
      case "$regex": {
        const re = target instanceof RegExp ? target : new RegExp(target, cond.$options || "")
        if (typeof val !== "string" || !re.test(val)) return false
        break
      }
      case "$options":
        break
      default:
        // Unknown operator — be tolerant at evaluation time. Callers that
        // want fail-fast behavior should pre-check with isSupportedFilter.
        return false
    }
  }
  return true
}

export function getPath(obj: any, path: string): any {
  if (!path.includes(".")) return obj?.[path]
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj)
}

export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return false
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
  if (filter == null) return true
  if (typeof filter !== "object") return true
  for (const [key, cond] of Object.entries(filter)) {
    if (UNSUPPORTED_OPS.has(key)) return false
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(cond)) return false
      for (const sub of cond) {
        if (!isSupportedFilter(sub)) return false
      }
      continue
    }
    if (key === "$not") {
      if (!isSupportedFilter(cond)) return false
      continue
    }
    if (key.startsWith("$")) {
      // Top-level unrecognized operator
      if (!TOP_OPS.has(key)) return false
      continue
    }
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      for (const op of Object.keys(cond)) {
        if (op.startsWith("$") && !SCALAR_OPS.has(op)) return false
        if (UNSUPPORTED_OPS.has(op)) return false
      }
    }
  }
  return true
}
