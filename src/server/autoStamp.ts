// Server-side auto-stamp wrapper. Injects createdAt/updatedAt/deletedAt on
// writes so the sync checkpoint has something to filter on without burdening
// handler authors. For sync-enabled models, deleteOne/deleteMany are rewritten
// to a $set on deletedAt so the sync engine can propagate tombstones — non-sync
// models keep MongoDB's native delete semantics. Sync-mode handlers that
// genuinely need a hard delete can still bypass via `db.collection.deleteOne()`.

import { isSyncEnabled, isValidationEnabled, getModelZodSchema, isTimeseries } from "@/runtime/models"

function isUpdateOperatorObject(update: any): boolean {
  if (!update || typeof update !== "object") return false
  for (const k of Object.keys(update)) {
    if (k.startsWith("$")) return true
  }
  return false
}

function formatZodIssues(error: any): string {
  const issues = error?.issues || error?.errors
  if (!Array.isArray(issues)) return String(error?.message ?? error)
  return issues
    .map((iss: any) => {
      const path = Array.isArray(iss.path) && iss.path.length ? iss.path.join(".") : "<root>"
      return `${path}: ${iss.message}`
    })
    .join("; ")
}

function validationError(model: string, op: string, error: any): Error {
  return new Error(
    `[mogobase] Validation failed for ${model}.${op}: ${formatZodIssues(error)}`
  )
}

function validateFullDoc(model: string, op: string, doc: any): void {
  const zod = getModelZodSchema(model)
  if (!zod) return
  const result = zod.safeParse(doc)
  if (!result.success) throw validationError(model, op, result.error)
}

function validatePartial(model: string, op: string, patch: any): void {
  const zod = getModelZodSchema(model)
  if (!zod) return
  const partial = typeof zod.partial === "function" ? zod.partial() : zod
  const result = partial.safeParse(patch)
  if (!result.success) throw validationError(model, op, result.error)
}

// Validate an update payload against the model schema.
//   - Aggregation pipeline updates ([{$set: ...}, ...]): skipped — no generic
//     way to statically check the result shape.
//   - $-operator updates: validate $set (and $setOnInsert if present) as partials.
//   - Full-replace update: validate the whole doc.
function validateUpdate(model: string, op: string, update: any): void {
  if (Array.isArray(update)) return
  if (!update || typeof update !== "object") return
  if (isUpdateOperatorObject(update)) {
    if (update.$set && typeof update.$set === "object") {
      validatePartial(model, op, update.$set)
    }
    if (update.$setOnInsert && typeof update.$setOnInsert === "object") {
      validatePartial(model, op, update.$setOnInsert)
    }
    return
  }
  validateFullDoc(model, op, update)
}

function injectUpdatedAt(update: any, now: number): any {
  if (Array.isArray(update)) {
    // Aggregation pipeline update — append a $set stage at the end.
    return [...update, { $set: { updatedAt: now } }]
  }
  if (isUpdateOperatorObject(update)) {
    const next = { ...update }
    next.$set = { ...(next.$set || {}), updatedAt: now }
    return next
  }
  // Full replace — inject directly.
  return { ...update, updatedAt: now }
}

function wrapCollectionWithAutoStamp(col: any, name?: string): any {
  if (!col) return col
  const sync = name ? isSyncEnabled(name) : false
  const validate = name ? isValidationEnabled(name) : false
  // Timeseries collections cannot soft-delete (we never propagate tombstones
  // for them) and their `deletedAt` field would just bloat each measurement.
  // Inserts skip the `deletedAt:null` stamp and deletes pass through to
  // MongoDB's native timeseries delete path.
  const timeseries = name ? isTimeseries(name) : false
  return new Proxy(col, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver)
      if (prop === "insertOne" && typeof original === "function") {
        return (doc: any, ...rest: any[]) => {
          const now = Date.now()
          const stamped: any = timeseries
            ? { createdAt: now, updatedAt: now, ...(doc || {}) }
            : { createdAt: now, updatedAt: now, deletedAt: null, ...(doc || {}) }
          if (!stamped.updatedAt) stamped.updatedAt = now
          if (!stamped.createdAt) stamped.createdAt = now
          if (!timeseries && stamped.deletedAt === undefined) stamped.deletedAt = null
          if (validate && name) validateFullDoc(name, "insertOne", stamped)
          return original.call(target, stamped, ...rest)
        }
      }
      if (prop === "insertMany" && typeof original === "function") {
        return (docs: any[], ...rest: any[]) => {
          const now = Date.now()
          const stamped = (docs || []).map((doc: any) => {
            const next: any = timeseries
              ? { createdAt: now, updatedAt: now, ...(doc || {}) }
              : { createdAt: now, updatedAt: now, deletedAt: null, ...(doc || {}) }
            if (!next.updatedAt) next.updatedAt = now
            if (!next.createdAt) next.createdAt = now
            if (!timeseries && next.deletedAt === undefined) next.deletedAt = null
            return next
          })
          if (validate && name) {
            for (const d of stamped) validateFullDoc(name, "insertMany", d)
          }
          return original.call(target, stamped, ...rest)
        }
      }
      if ((prop === "updateOne" || prop === "updateMany") && typeof original === "function") {
        return (filter: any, update: any, ...rest: any[]) => {
          const now = Date.now()
          const stampedUpdate = injectUpdatedAt(update, now)
          if (validate && name) validateUpdate(name, prop as string, stampedUpdate)
          return original.call(target, filter, stampedUpdate, ...rest)
        }
      }
      if (prop === "deleteOne" && typeof original === "function") {
        return (filter: any, ...rest: any[]) => {
          if (!sync || timeseries) return original.call(target, filter, ...rest)
          const now = Date.now()
          const updateOne = (target as any).updateOne?.bind(target)
          if (typeof updateOne !== "function") {
            return original.call(target, filter, ...rest)
          }
          return updateOne(filter, { $set: { deletedAt: now, updatedAt: now } }, ...rest)
        }
      }
      if (prop === "deleteMany" && typeof original === "function") {
        return (filter: any, ...rest: any[]) => {
          if (!sync || timeseries) return original.call(target, filter, ...rest)
          const now = Date.now()
          const updateMany = (target as any).updateMany?.bind(target)
          if (typeof updateMany !== "function") {
            return original.call(target, filter, ...rest)
          }
          return updateMany(filter, { $set: { deletedAt: now, updatedAt: now } }, ...rest)
        }
      }
      if (prop === "findOneAndUpdate" && typeof original === "function") {
        return (filter: any, update: any, ...rest: any[]) => {
          const now = Date.now()
          const stampedUpdate = injectUpdatedAt(update, now)
          if (validate && name) validateUpdate(name, "findOneAndUpdate", stampedUpdate)
          return original.call(target, filter, stampedUpdate, ...rest)
        }
      }
      if (prop === "findOneAndDelete" && typeof original === "function") {
        return (filter: any, ...rest: any[]) => {
          if (!sync || timeseries) return original.call(target, filter, ...rest)
          const now = Date.now()
          const findOneAndUpdate = (target as any).findOneAndUpdate?.bind(target)
          if (typeof findOneAndUpdate !== "function") {
            return original.call(target, filter, ...rest)
          }
          return findOneAndUpdate(
            filter,
            { $set: { deletedAt: now, updatedAt: now } },
            ...rest
          )
        }
      }
      // For everything else (find, aggregate, watch, etc.), bind to the original target.
      if (typeof original === "function") return original.bind(target)
      return original
    },
  })
}

export function wrapDbWithAutoStamp(db: any): any {
  if (!db || typeof db.model !== "function") return db
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "model") {
        return (name: string) => wrapCollectionWithAutoStamp(target.model(name), name)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

export { injectUpdatedAt }
