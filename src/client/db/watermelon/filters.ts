// src/client/db/watermelon/filters.ts
//
// Watermelon-specific JSON-blob helpers + a re-export of the shared filter
// matcher from @/runtime/filterMatcher. The matcher used to live here; it
// was extracted so server/streamHub can use the same evaluator MongoDB-side
// without duplicating logic.

export { matches, matchesValue, getPath, deepEqual } from "@/runtime/filterMatcher"
export type { MongoFilter } from "@/runtime/filterMatcher"

export type MongoUpdate = any

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
