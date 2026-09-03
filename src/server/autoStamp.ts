// Server-side auto-stamp wrapper. Injects createdAt/updatedAt/deletedAt on
// writes so the sync checkpoint has something to filter on without burdening
// handler authors. For sync-enabled models, deleteOne/deleteMany are rewritten
// to a $set on deletedAt so the sync engine can propagate tombstones — non-sync
// models keep MongoDB's native delete semantics. Sync-mode handlers that
// genuinely need a hard delete can still bypass via `db.collection.deleteOne()`.

import { isSyncEnabled, isValidationEnabled, getModelZodSchema, isTimeseries } from "@/runtime/models"
import {
  schemaHasDecimal128,
  encodeDecimal128,
  encodeDecimal128Patch,
  decodeDecimal128Deep,
} from "@/runtime/decimal"

// Do NOT `import … from "mongodb"` here. This module is statically imported by
// the browser-safe handlers.ts (re-exported via mogobase/runtime, consumed by
// client hooks); a static mongodb import pulls client-side-encryption →
// require("child_process") into the client bundle. The real Decimal128 factory
// is injected through the server-only globalThis channel published by
// `mogobase/db`. On the client (offline path) the value stays a plain string,
// which is the documented client-side representation of a decimal128 field.
const DB_GLOBAL_KEY = "__mogobase_db__"
const makeDecimal = (s: string): any => {
  const g = globalThis as unknown as Record<string, { makeDecimal?: (s: string) => any }>
  const fn = g[DB_GLOBAL_KEY]?.makeDecimal
  return fn ? fn(s) : s
}

// Schema-guided write encode for a full doc (insert / full-replace).
function encodeDoc(zod: any, doc: any): any {
  return encodeDecimal128(zod, doc, makeDecimal)
}

// Schema-guided write encode for an update payload. Aggregation-pipeline
// updates ([{$set:...}]) are passed through — the result shape can't be
// statically resolved against the schema. Operator updates encode their
// `$set`/`$setOnInsert`; a full-replace doc is encoded directly.
function encodeUpdate(zod: any, update: any): any {
  if (Array.isArray(update)) return update
  if (!update || typeof update !== "object") return update
  if (isUpdateOperatorObject(update)) {
    const next: any = { ...update }
    if (next.$set && typeof next.$set === "object") {
      next.$set = encodeDecimal128Patch(zod, next.$set, makeDecimal)
    }
    if (next.$setOnInsert && typeof next.$setOnInsert === "object") {
      next.$setOnInsert = encodeDecimal128Patch(zod, next.$setOnInsert, makeDecimal)
    }
    return next
  }
  return encodeDoc(zod, update)
}

// Wrap a find/aggregate cursor so every doc it yields is decimal-decoded.
// Chainable methods (sort/limit/skip/project/map/…) return the cursor itself
// in the mongodb driver — re-wrap so the decode survives the chain. Terminal
// methods (toArray/next/tryNext/forEach/async-iterator) decode their output.
function wrapCursorWithDecode(cursor: any): any {
  if (!cursor || typeof cursor !== "object") return cursor
  return new Proxy(cursor, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver)
      if ((prop === "toArray" || prop === "next" || prop === "tryNext") && typeof orig === "function") {
        return async (...a: any[]) => decodeDecimal128Deep(await orig.apply(target, a))
      }
      if (prop === "forEach" && typeof orig === "function") {
        return (cb: any, ...a: any[]) =>
          orig.call(target, (d: any) => cb(decodeDecimal128Deep(d)), ...a)
      }
      if (prop === Symbol.asyncIterator && typeof orig === "function") {
        return function () {
          const it = orig.call(target)
          return {
            async next() {
              const r = await it.next()
              return r.done ? r : { done: false, value: decodeDecimal128Deep(r.value) }
            },
            return: typeof it.return === "function" ? (x: any) => it.return(x) : undefined,
            [Symbol.asyncIterator]() {
              return this
            },
          }
        }
      }
      if (typeof orig === "function") {
        return (...a: any[]) => {
          const res = orig.apply(target, a)
          if (res === target) return receiver
          return res && typeof res.toArray === "function" ? wrapCursorWithDecode(res) : res
        }
      }
      return orig
    },
  })
}

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

/**
 * The birth stamps for an UPSERT, in `$setOnInsert` so they apply only on the
 * insert branch.
 *
 * `injectUpdatedAt` alone leaves an upsert-born document with `updatedAt` and
 * nothing else: `createdAt` is missing, so every screen that renders one gets
 * `undefined` — which `new Date(undefined)` and dayjs both read as NOW, so the
 * row silently reports today, every day, forever. `deletedAt` is missing too,
 * so a sync-enabled model's tombstone filters skip the row.
 *
 * `$setOnInsert` and `$set` must not name the same path (MongoDB errors), which
 * is exactly why `updatedAt` stays in `$set` and only the birth stamps go here.
 * A caller who supplied either one keeps it — same precedence as `insertOne`,
 * where the document spread wins over the stamp.
 */
function injectInsertStamps(update: any, now: number, timeseries: boolean): any {
  // An aggregation-pipeline update has no `$setOnInsert` stage to add to; its
  // upsert branch is Mongo's own and cannot be stamped from here.
  if (Array.isArray(update)) return update
  // A full-replace upsert inserts the replacement document verbatim, so the
  // stamps belong in the document itself.
  if (!isUpdateOperatorObject(update)) {
    const replacement = { ...update }
    if (replacement.createdAt === undefined) replacement.createdAt = now
    if (!timeseries && replacement.deletedAt === undefined) replacement.deletedAt = null
    return replacement
  }
  const next = { ...update }
  const onInsert = { ...(next.$setOnInsert || {}) }
  const claimed = (path: string) =>
    onInsert[path] !== undefined || (next.$set && next.$set[path] !== undefined)
  if (!claimed("createdAt")) onInsert.createdAt = now
  if (!timeseries && !claimed("deletedAt")) onInsert.deletedAt = null
  next.$setOnInsert = onInsert
  return next
}

/** Whether a driver options bag (or a bulkWrite op) asked for an upsert. */
const isUpsert = (options: any): boolean => options?.upsert === true

function wrapCollectionWithAutoStamp(col: any, name?: string): any {
  if (!col) return col
  const sync = name ? isSyncEnabled(name) : false
  const validate = name ? isValidationEnabled(name) : false
  // Timeseries collections cannot soft-delete (we never propagate tombstones
  // for them) and their `deletedAt` field would just bloat each measurement.
  // Inserts skip the `deletedAt:null` stamp and deletes pass through to
  // MongoDB's native timeseries delete path.
  const timeseries = name ? isTimeseries(name) : false
  // Decimal128 codec is opt-in per model: skip the encode/decode walks
  // entirely unless the schema declares at least one `v.decimal128()` field.
  const zod = name ? getModelZodSchema(name) : undefined
  const hasDecimal = zod ? schemaHasDecimal128(zod) : false
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
          const enc = hasDecimal ? encodeDoc(zod, stamped) : stamped
          return original.call(target, enc, ...rest)
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
          const enc = hasDecimal ? stamped.map((d: any) => encodeDoc(zod, d)) : stamped
          return original.call(target, enc, ...rest)
        }
      }
      if ((prop === "updateOne" || prop === "updateMany") && typeof original === "function") {
        return (filter: any, update: any, ...rest: any[]) => {
          const now = Date.now()
          let stampedUpdate = injectUpdatedAt(update, now)
          // An upsert that INSERTS is a birth, and has to be stamped like one.
          if (isUpsert(rest[0])) stampedUpdate = injectInsertStamps(stampedUpdate, now, timeseries)
          if (validate && name) validateUpdate(name, prop as string, stampedUpdate)
          const encUpdate = hasDecimal ? encodeUpdate(zod, stampedUpdate) : stampedUpdate
          return original.call(target, filter, encUpdate, ...rest)
        }
      }
      if (prop === "replaceOne" && typeof original === "function") {
        return (filter: any, replacement: any, ...rest: any[]) => {
          const now = Date.now()
          let next = { ...(replacement || {}), updatedAt: now }
          if (isUpsert(rest[0])) next = injectInsertStamps(next, now, timeseries)
          if (validate && name) validateFullDoc(name, "replaceOne", next)
          const enc = hasDecimal ? encodeDoc(zod, next) : next
          return original.call(target, filter, enc, ...rest)
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
          let stampedUpdate = injectUpdatedAt(update, now)
          if (isUpsert(rest[0])) stampedUpdate = injectInsertStamps(stampedUpdate, now, timeseries)
          if (validate && name) validateUpdate(name, "findOneAndUpdate", stampedUpdate)
          const encUpdate = hasDecimal ? encodeUpdate(zod, stampedUpdate) : stampedUpdate
          if (!hasDecimal) return original.call(target, filter, encUpdate, ...rest)
          return Promise.resolve(original.call(target, filter, encUpdate, ...rest)).then(
            decodeDecimal128Deep
          )
        }
      }
      if (prop === "findOneAndDelete" && typeof original === "function") {
        return (filter: any, ...rest: any[]) => {
          if (!sync || timeseries) {
            if (!hasDecimal) return original.call(target, filter, ...rest)
            return Promise.resolve(original.call(target, filter, ...rest)).then(
              decodeDecimal128Deep
            )
          }
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
      /**
       * `bulkWrite` used to fall through to the driver untouched, so every
       * document it inserted or upserted was born with NO engine stamps at all
       * — the one write path that silently opted out of the whole contract.
       * Metrics rollups and importers reach for it precisely because they write
       * many rows, so the gap scaled with volume.
       *
       * Each operation is stamped exactly as its single-document twin would be,
       * including per-op `upsert`, which bulkWrite carries on the op rather than
       * in an options bag. Deletes on a sync model are rewritten to tombstone
       * updates for the same reason `deleteOne` is.
       */
      if (prop === "bulkWrite" && typeof original === "function") {
        return (operations: any[], ...rest: any[]) => {
          const now = Date.now()
          const stampInsert = (doc: any) => {
            const next: any = timeseries
              ? { createdAt: now, updatedAt: now, ...(doc || {}) }
              : { createdAt: now, updatedAt: now, deletedAt: null, ...(doc || {}) }
            if (!next.updatedAt) next.updatedAt = now
            if (!next.createdAt) next.createdAt = now
            if (!timeseries && next.deletedAt === undefined) next.deletedAt = null
            if (validate && name) validateFullDoc(name, "bulkWrite", next)
            return hasDecimal ? encodeDoc(zod, next) : next
          }
          const stampUpdate = (op: any, kind: string) => {
            let update = injectUpdatedAt(op.update, now)
            if (isUpsert(op)) update = injectInsertStamps(update, now, timeseries)
            if (validate && name) validateUpdate(name, kind, update)
            return { ...op, update: hasDecimal ? encodeUpdate(zod, update) : update }
          }
          const stamped = (operations || []).map((op: any) => {
            if (!op || typeof op !== "object") return op
            if (op.insertOne) return { insertOne: { ...op.insertOne, document: stampInsert(op.insertOne.document) } }
            if (op.updateOne) return { updateOne: stampUpdate(op.updateOne, "bulkWrite.updateOne") }
            if (op.updateMany) return { updateMany: stampUpdate(op.updateMany, "bulkWrite.updateMany") }
            if (op.replaceOne) {
              let replacement = { ...(op.replaceOne.replacement || {}), updatedAt: now }
              if (isUpsert(op.replaceOne)) replacement = injectInsertStamps(replacement, now, timeseries)
              if (validate && name) validateFullDoc(name, "bulkWrite.replaceOne", replacement)
              return {
                replaceOne: {
                  ...op.replaceOne,
                  replacement: hasDecimal ? encodeDoc(zod, replacement) : replacement,
                },
              }
            }
            // Soft-delete rewrite, mirroring deleteOne/deleteMany above: a sync
            // model propagates tombstones, so a hard delete in a bulk batch would
            // vanish from every client's checkpoint without one.
            if (!sync || timeseries) return op
            if (op.deleteOne) return { updateOne: { filter: op.deleteOne.filter, update: { $set: { deletedAt: now, updatedAt: now } } } }
            if (op.deleteMany) return { updateMany: { filter: op.deleteMany.filter, update: { $set: { deletedAt: now, updatedAt: now } } } }
            return op
          })
          return original.call(target, stamped, ...rest)
        }
      }
      // Read decode — only for models that declare a decimal128 field.
      if (hasDecimal && prop === "findOne" && typeof original === "function") {
        return (...a: any[]) =>
          Promise.resolve(original.apply(target, a)).then(decodeDecimal128Deep)
      }
      if (hasDecimal && (prop === "find" || prop === "aggregate") && typeof original === "function") {
        return (...a: any[]) => wrapCursorWithDecode(original.apply(target, a))
      }
      // For everything else (watch, countDocuments, etc.), bind to the original target.
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
