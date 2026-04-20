// Minimal JS-side Mongo filter matcher used by the live-query layer to decide
// whether a change-stream `fullDocument` / `fullDocumentBeforeChange` belongs
// to a `ctx.watch` filter set. Mirrors the matcher shipped with the
// WatermelonDB backend (see src/client/db/watermelon/filters.ts).

export type MongoFilter = Record<string, any>

function getPath(obj: any, path: string): any {
  if (!path.includes(".")) return obj?.[path]
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj)
}

function deepEqual(a: any, b: any): boolean {
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

function matchesValue(val: any, cond: any): boolean {
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
        console.warn(`[mogobase] unsupported filter operator ${op}`)
    }
  }
  return true
}

export function matchFilter(doc: any, filter: MongoFilter | null | undefined): boolean {
  if (!filter || typeof filter !== "object") return true
  if (!doc) return false
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$and") {
      if (!(cond as any[]).every((c) => matchFilter(doc, c))) return false
      continue
    }
    if (key === "$or") {
      if (!(cond as any[]).some((c) => matchFilter(doc, c))) return false
      continue
    }
    if (key === "$not") {
      if (matchFilter(doc, cond as any)) return false
      continue
    }
    const val = getPath(doc, key)
    if (!matchesValue(val, cond)) return false
  }
  return true
}
