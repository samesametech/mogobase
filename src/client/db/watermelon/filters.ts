// JS-side Mongo filter matcher + update applier for the WatermelonDB backend.
// The storage strategy is one JSON blob per record (see ./adapter) so queries
// cannot push down into Watermelon's Q.* builder — they are evaluated here on
// the decoded document. This keeps consumer handler code (written against the
// MongoDB driver shape) working unchanged on the offline path.

export type MongoFilter = any
export type MongoUpdate = any

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
        console.warn(`[mogobase/watermelon] unsupported operator ${op}`)
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
  const ka = Object.keys(a),
    kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}

export function applyUpdate(doc: any, update: MongoUpdate): any {
  if (!update || typeof update !== "object") return doc
  const hasOps = Object.keys(update).some((k) => k.startsWith("$"))
  if (!hasOps) return { ...update, _id: doc._id }
  const next = { ...doc }
  if (update.$set) Object.assign(next, update.$set)
  if (update.$unset) for (const k of Object.keys(update.$unset)) delete (next as any)[k]
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc as Record<string, number>)) {
      ;(next as any)[k] = ((next as any)[k] || 0) + v
    }
  }
  if (update.$push) {
    for (const [k, v] of Object.entries(update.$push as Record<string, any>)) {
      const arr = Array.isArray((next as any)[k]) ? [...(next as any)[k]] : []
      arr.push(v)
      ;(next as any)[k] = arr
    }
  }
  if (update.$pull) {
    for (const [k, v] of Object.entries(update.$pull as Record<string, any>)) {
      const arr = Array.isArray((next as any)[k]) ? (next as any)[k] : []
      ;(next as any)[k] = arr.filter((item: any) => item !== v && JSON.stringify(item) !== JSON.stringify(v))
    }
  }
  return next
}

export function decodeRaw(raw: any): any {
  try {
    return raw.data ? JSON.parse(raw.data) : {}
  } catch {
    return {}
  }
}

export function genId(): string {
  if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
