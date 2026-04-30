// Server-side auto-stamp wrapper. Injects createdAt/updatedAt/deletedAt on
// writes so the sync checkpoint has something to filter on without burdening
// handler authors. For sync-enabled models, deleteOne/deleteMany are rewritten
// to a $set on deletedAt so the sync engine can propagate tombstones — non-sync
// models keep MongoDB's native delete semantics. Sync-mode handlers that
// genuinely need a hard delete can still bypass via `db.collection.deleteOne()`.

import { isSyncEnabled } from "@/runtime/models"

function isUpdateOperatorObject(update: any): boolean {
  if (!update || typeof update !== "object") return false
  for (const k of Object.keys(update)) {
    if (k.startsWith("$")) return true
  }
  return false
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
  return new Proxy(col, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver)
      if (prop === "insertOne" && typeof original === "function") {
        return (doc: any, ...rest: any[]) => {
          const now = Date.now()
          const stamped = {
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            ...(doc || {}),
          }
          if (!stamped.updatedAt) stamped.updatedAt = now
          if (!stamped.createdAt) stamped.createdAt = now
          if (stamped.deletedAt === undefined) stamped.deletedAt = null
          return original.call(target, stamped, ...rest)
        }
      }
      if (prop === "insertMany" && typeof original === "function") {
        return (docs: any[], ...rest: any[]) => {
          const now = Date.now()
          const stamped = (docs || []).map((doc: any) => {
            const next = {
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
              ...(doc || {}),
            }
            if (!next.updatedAt) next.updatedAt = now
            if (!next.createdAt) next.createdAt = now
            if (next.deletedAt === undefined) next.deletedAt = null
            return next
          })
          return original.call(target, stamped, ...rest)
        }
      }
      if ((prop === "updateOne" || prop === "updateMany") && typeof original === "function") {
        return (filter: any, update: any, ...rest: any[]) => {
          const now = Date.now()
          return original.call(target, filter, injectUpdatedAt(update, now), ...rest)
        }
      }
      if (prop === "deleteOne" && typeof original === "function") {
        return (filter: any, ...rest: any[]) => {
          if (!sync) return original.call(target, filter, ...rest)
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
          if (!sync) return original.call(target, filter, ...rest)
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
          return original.call(target, filter, injectUpdatedAt(update, now), ...rest)
        }
      }
      if (prop === "findOneAndDelete" && typeof original === "function") {
        return (filter: any, ...rest: any[]) => {
          if (!sync) return original.call(target, filter, ...rest)
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
