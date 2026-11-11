// Server-side auto-stamp wrapper. Injects createdAt/updatedAt/deletedAt on
// writes so the sync checkpoint has something to filter on without burdening
// handler authors. For sync-enabled models, deleteOne/deleteMany are rewritten
// to a $set on deletedAt so the sync engine can propagate tombstones — non-sync
// models keep MongoDB's native delete semantics. Sync-mode handlers that
// genuinely need a hard delete can still bypass via `db.collection.deleteOne()`.

import { isSyncEnabled, isValidationEnabled, getModelZodSchema, isTimeseries, STAMP_INDEX_FIELDS } from "@/runtime/models"
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

// A replacement (not an upsert) as a full document, with stand-ins for the engine stamps it cannot
// know: the stored row's createdAt and deletedAt, which the pipeline keeps (keepingStamps) and
// withSyncFields makes required — a check without them refused findOneAndReplace({ _id }, { name })
// (on main it passed through). Stand-ins, not .partial(): zod v4 refuses .partial() on an object
// schema carrying a refinement, and every replace on such a model threw. Everything the caller set
// is checked, the schema's own refinements included.
function validateReplacement(model: string, op: string, doc: any): void {
  const zod = getModelZodSchema(model)
  if (!zod) return
  const shape = zod.shape ?? {}
  const full = { ...doc }
  if (full.createdAt === undefined && "createdAt" in shape) full.createdAt = doc.updatedAt
  if (full.deletedAt === undefined && "deletedAt" in shape) full.deletedAt = null
  const result = zod.safeParse(full)
  if (!result.success) throw validationError(model, op, result.error)
}

// An object schema's fields without its own refinements: zod v4 refuses .partial() on a schema
// carrying one (every $set on such a model threw), and a refinement over the whole document cannot
// judge a patch anyway. The fields' own checks and the unknown-key mode are kept.
function fieldsOnly(zod: any): any {
  const def = zod?._zod?.def
  if (!def?.checks?.length || !zod.shape || typeof zod.clone !== "function") return zod
  return zod.clone({ ...def, checks: [] })
}

// One partial per schema: built per write, a dbValidation model made two zod objects per $set.
const partials = new WeakMap<object, any>()

function validatePartial(model: string, op: string, patch: any): void {
  const zod = getModelZodSchema(model)
  if (!zod) return
  let partial = partials.get(zod)
  if (!partial) {
    const fields = fieldsOnly(zod)
    partial = typeof fields.partial === "function" ? fields.partial() : fields
    partials.set(zod, partial)
  }
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

/**
 * The birth stamps for a document being INSERTED: a value the caller supplied
 * wins, except a falsy `createdAt`/`updatedAt`, which is stamped over. Returns a
 * new object with the stamps first — that copy is what gets stored.
 */
function stampInsert(doc: any, now: number, timeseries: boolean): any {
  const next: any = timeseries
    ? { createdAt: now, updatedAt: now, ...(doc || {}) }
    : { createdAt: now, updatedAt: now, deletedAt: null, ...(doc || {}) }
  if (!next.updatedAt) next.updatedAt = now
  if (!next.createdAt) next.createdAt = now
  if (!timeseries && next.deletedAt === undefined) next.deletedAt = null
  return next
}

// The engine's stamps: the registry's one list (the order does not matter here).
const ENGINE_STAMPS = STAMP_INDEX_FIELDS

// A sync model's soft delete touches live rows only: matching tombstones too, deleteOne({ listId })
// could re-tombstone a row deleted long ago — bumping its updatedAt, so every client pulled it
// again — and leave the live one.
const liveOnly = (filter: any): any => ({ $and: [filter ?? {}, { deletedAt: null }] })

// A replacement as an update pipeline that keeps the stored row's engine stamps: the row's _id,
// createdAt and deletedAt merged UNDER the replacement (the caller's own win), the replacement taken
// as a literal (no field of it read as an expression). A plain replace dropped both stamps — a
// screen showed today as the row's birth, and replacing a tombstoned row brought it back on every
// client. On an upsert that inserts there is no stored row: createdAt is `now` and deletedAt null
// ($ifNull) — and an upsert that MATCHES keeps them, where stamping them into the replacement
// overwrote both. Atomic, unlike reading them first. Its change event is an `update`.
// (Never for a time-series model, which stays a replace: see replacementWrite.)
const keepingStamps = (replacement: Record<string, unknown>, now: number): Record<string, unknown>[] => [
  {
    $replaceWith: {
      $mergeObjects: [
        { _id: "$_id", createdAt: { $ifNull: ["$createdAt", now] }, deletedAt: { $ifNull: ["$deletedAt", null] } },
        { $literal: replacement },
      ],
    },
  },
]

// The soft delete's UpdateResult, with the deletedCount a caller of deleteOne/deleteMany reads.
const asDeleteResult = (res: any): any => (res && typeof res === "object" ? { ...res, deletedCount: res.modifiedCount ?? 0 } : res)

/**
 * The values stampCallerDoc wrote onto a caller's object — so that a later insert of the SAME
 * object does not take them for its caller's own. Without this, re-inserting an object (a
 * template in a loop, a row copied to a second collection) resent the first insert's `_id` —
 * a duplicate-key error, or a reused id elsewhere — and kept its stale stamps, where before
 * the write-back each insert got a fresh `_id` and fresh stamps. A value the caller set (or
 * changed) after an insert is the caller's, and is kept.
 */
const writtenBack = new WeakMap<object, Record<string, unknown>>()

/**
 * The same records, keyed by the `_id` instance written back: a spread copy (`{ ...row, x }`)
 * is a new object, but it carries the very ObjectId the driver generated, so an update's $set
 * built from one is recognised too (see ownedUpdate).
 */
const writtenBackById = new WeakMap<object, Record<string, unknown>>()

/**
 * The caller's document minus the values mogobase itself wrote onto it at an earlier insert — or
 * onto the object it was spread from (`{ ...base, name: "b" }`, recognised by spreadFrom): the
 * copy carried base's written-back _id, so inserting it was a duplicate key (a reused id in
 * another collection), where before the write-back each insert got a fresh one.
 */
function callerOwned(doc: any): any {
  if (!doc || typeof doc !== "object") return doc
  const ours = writtenBack.get(doc) ?? spreadFrom(doc, doc._id)
  return ours ? withoutOurs(doc, ours) : doc
}

/** A copy of `doc` without each value of `ours` it still holds unchanged. */
function withoutOurs(doc: any, ours: Record<string, unknown>): any {
  const own = { ...doc }
  for (const [key, value] of Object.entries(ours)) if (own[key] === value) delete own[key]
  return own
}

/**
 * After a successful insert, write what the stored row got back onto the
 * CALLER'S object: its engine stamps, and the `_id` the driver generated if the
 * caller set none — the driver writes `_id` onto the document it is handed, but
 * that is our stamped copy, so neither ever reached the caller. A handler that
 * returned or emitted what it had just inserted shipped null timestamps, and
 * apps re-read every row they created to get them.
 *
 * The stored row is untouched by this: still the stamped copy, same fields in
 * the same order. A failed or validation-refused insert never gets here, so the
 * caller's object stays as it was. `Reflect.set`, not assignment: a frozen
 * document inserts as before, just not written back, instead of throwing.
 *
 * `own` is the document as the caller supplied it (see callerOwned): a value that differs
 * from it was chosen by mogobase, and is remembered as such in `writtenBack`.
 */
function stampCallerDoc(doc: any, own: any, stamped: any, insertedId: unknown): void {
  if (!doc || typeof doc !== "object") return
  const ours: Record<string, unknown> = {}
  for (const key of ENGINE_STAMPS) {
    if (!(key in stamped)) continue
    // Read before writing: `own` is the caller's object itself when nothing was written back yet.
    const callerValue = own?.[key]
    if (doc[key] !== stamped[key]) Reflect.set(doc, key, stamped[key])
    if (doc[key] === stamped[key] && stamped[key] !== callerValue) ours[key] = stamped[key]
  }
  if (insertedId != null && own?._id == null) {
    Reflect.set(doc, "_id", insertedId)
    if (doc._id === insertedId) ours._id = insertedId
  }
  if (Object.keys(ours).length) writtenBack.set(doc, ours)
  else writtenBack.delete(doc)
  if (ours._id && typeof ours._id === "object") writtenBackById.set(ours._id, ours)
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
  // Decimal128 codec is opt-in per model: skip the encode/decode walks
  // entirely unless the schema declares at least one `v.decimal128()` field.
  const zod = name ? getModelZodSchema(name) : undefined
  const hasDecimal = zod ? schemaHasDecimal128(zod) : false
  const proxy = new Proxy(col, {
    get(target, prop, receiver) {
      const fn = stampedMember(target, prop, receiver)
      // An object insertOne/insertMany wrote back onto, used again inside an update's $set, is
      // used as the caller set it (see OWNED_ARG_METHODS).
      if (typeof fn !== "function" || !OWNED_ARG_METHODS.has(prop as string)) return fn
      return (...args: any[]) => fn(...ownedArgs(prop as string, args))
    },
  })
  return proxy

  // The write a replace becomes: an update pipeline keeping the stored row's stamps (keepingStamps)
  // — for an upsert too — validated without the stamps the stored row (or the pipeline) supplies.
  // A time-series collection has no update of a whole measurement: it stays a replace, with birth
  // stamps on an upsert. One decision for replaceOne, findOneAndReplace and bulkWrite's replaceOne.
  function replacementWrite(replacement: any, upsert: boolean, op: string): { pipeline: Record<string, unknown>[] } | { doc: any } {
    const now = Date.now()
    let next = { ...(replacement || {}), updatedAt: now }
    if (timeseries) {
      if (upsert) next = injectInsertStamps(next, now, timeseries)
      if (validate && name) (upsert ? validateFullDoc : validateReplacement)(name, op, next)
      return { doc: hasDecimal ? encodeDoc(zod, next) : next }
    }
    if (validate && name) validateReplacement(name, op, next)
    return { pipeline: keepingStamps(hasDecimal ? encodeDoc(zod, next) : next, now) }
  }

  function stampedMember(target: any, prop: string | symbol, receiver: any): any {
      const original = Reflect.get(target, prop, receiver)
      if (prop === "insertOne" && typeof original === "function") {
        return (doc: any, ...rest: any[]) => {
          const own = callerOwned(doc)
          const stamped = stampInsert(own, Date.now(), timeseries)
          if (validate && name) validateFullDoc(name, "insertOne", stamped)
          const enc = hasDecimal ? encodeDoc(zod, stamped) : stamped
          return Promise.resolve(original.call(target, enc, ...rest)).then((res: any) => {
            stampCallerDoc(doc, own, stamped, res?.insertedId)
            return res
          })
        }
      }
      if (prop === "insertMany" && typeof original === "function") {
        return (docs: any[], ...rest: any[]) => {
          const now = Date.now()
          const owns = (docs || []).map(callerOwned)
          const stamped = owns.map((own: any) => stampInsert(own, now, timeseries))
          if (validate && name) {
            for (const d of stamped) validateFullDoc(name, "insertMany", d)
          }
          const enc = hasDecimal ? stamped.map((d: any) => encodeDoc(zod, d)) : stamped
          // A failed batch writes nothing back, even rows an ordered batch stored
          // before it failed: the caller is handling an error, not returning rows.
          return Promise.resolve(original.call(target, enc, ...rest)).then((res: any) => {
            stamped.forEach((s: any, i: number) => stampCallerDoc(docs[i], owns[i], s, res?.insertedIds?.[i]))
            return res
          })
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
          const write = replacementWrite(replacement, isUpsert(rest[0]), "replaceOne")
          if ("doc" in write) return original.call(target, filter, write.doc, ...rest)
          return (target as any).updateOne(filter, write.pipeline, ...rest)
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
          return Promise.resolve(updateOne(liveOnly(filter), { $set: { deletedAt: now, updatedAt: now } }, ...rest)).then(asDeleteResult)
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
          return Promise.resolve(updateMany(liveOnly(filter), { $set: { deletedAt: now, updatedAt: now } }, ...rest)).then(asDeleteResult)
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
          const tombstoned = findOneAndUpdate(liveOnly(filter), { $set: { deletedAt: now, updatedAt: now } }, ...rest)
          // Decoded as on every other path: a Decimal128 left in it serialized as {"$numberDecimal": …}.
          return hasDecimal ? Promise.resolve(tombstoned).then(decodeDecimal128Deep) : tombstoned
        }
      }
      /**
       * findOneAndReplace fell through to the driver untouched — no updatedAt, so on a sync model
       * the change never passed pullChanges' `updatedAt > checkpoint` and no client saw it; no
       * dbValidation, no Decimal128 encode or decode. It is stamped as replaceOne is.
       */
      if (prop === "findOneAndReplace" && typeof original === "function") {
        return (filter: any, replacement: any, ...rest: any[]) => {
          const write = replacementWrite(replacement, isUpsert(rest[0]), "findOneAndReplace")
          const result = "doc" in write ? original.call(target, filter, write.doc, ...rest) : (target as any).findOneAndUpdate(filter, write.pipeline, ...rest)
          return hasDecimal ? Promise.resolve(result).then(decodeDecimal128Deep) : result
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
          const stampInsertOp = (doc: any) => {
            // An object insertOne/insertMany wrote _id and stamps back onto is re-inserted as
            // what the caller set, as those two do: resent with the old _id it was a duplicate.
            const next = stampInsert(callerOwned(doc), now, timeseries)
            if (validate && name) validateFullDoc(name, "bulkWrite", next)
            return hasDecimal ? encodeDoc(zod, next) : next
          }
          const stampUpdate = (op: any, kind: string) => {
            // As updateOne/updateMany outside a batch (OWNED_ARG_METHODS).
            let update = injectUpdatedAt(ownedUpdate(op.update), now)
            if (isUpsert(op)) update = injectInsertStamps(update, now, timeseries)
            if (validate && name) validateUpdate(name, kind, update)
            return { ...op, update: hasDecimal ? encodeUpdate(zod, update) : update }
          }
          const stamped = (operations || []).map((op: any) => {
            if (!op || typeof op !== "object") return op
            if (op.insertOne) return { insertOne: { ...op.insertOne, document: stampInsertOp(op.insertOne.document) } }
            if (op.updateOne) return { updateOne: stampUpdate(op.updateOne, "bulkWrite.updateOne") }
            if (op.updateMany) return { updateMany: stampUpdate(op.updateMany, "bulkWrite.updateMany") }
            if (op.replaceOne) {
              const write = replacementWrite(op.replaceOne.replacement, isUpsert(op.replaceOne), "bulkWrite.replaceOne")
              if ("doc" in write) return { replaceOne: { ...op.replaceOne, replacement: write.doc } }
              // Kept stamps, as replaceOne; the op's upsert / collation / hint carried over.
              const { replacement: _replacement, ...rest } = op.replaceOne
              return { updateOne: { ...rest, update: write.pipeline } }
            }
            // Soft-delete rewrite, mirroring deleteOne/deleteMany above: a sync
            // model propagates tombstones, so a hard delete in a bulk batch would
            // vanish from every client's checkpoint without one.
            if (!sync || timeseries) return op
            // The op's own collation / hint carried over: rebuilt from its filter alone, a
            // case-insensitive delete matched case-sensitively and left the row live.
            if (op.deleteOne) return { updateOne: { ...op.deleteOne, filter: liveOnly(op.deleteOne.filter), update: { $set: { deletedAt: now, updatedAt: now } } } }
            if (op.deleteMany) return { updateMany: { ...op.deleteMany, filter: liveOnly(op.deleteMany.filter), update: { $set: { deletedAt: now, updatedAt: now } } } }
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
  }
}

// Where an object insertOne wrote back onto is used as the caller set it: inside an update's
// $set / $setOnInsert only — the object itself, or a copy spread from it (`{ ...row, x }`,
// recognised by the written-back _id it still carries), in updateOne/updateMany/
// findOneAndUpdate and their bulkWrite ops. There the written-back _id was never wanted — on
// another collection's row it is an immutable-field error, on the same row a no-op — and its
// createdAt overwrote the target's own (only those two: see UPDATE_STRIPPED). NOT in a filter: `deleteOne(inserted)`
// must target exactly that row, by the _id the caller can see (stripped, it matched any row
// with the same fields — and on a sync model tombstoned it). NOT in a replacement: replacing
// the row with its own object must keep its createdAt (stripped, it was lost); a replacement
// carrying another row's _id fails loudly instead.
const OWNED_ARG_METHODS = new Set(["updateOne", "updateMany", "findOneAndUpdate"])

function ownedArgs(_prop: string, args: any[]): any[] {
  if (args.length < 2) return args
  const update = ownedUpdate(args[1])
  if (update === args[1]) return args
  const out = [...args]
  out[1] = update
  return out
}

// What an update leaves out of the written-back values: the _id (an immutable-field error on
// another row, a no-op on its own) and createdAt (another row's birth). NOT deletedAt: a
// `deletedAt: null` in $set is a no-op on a live row and a restore on a deleted one — and a
// restore is something only the caller asks for (`$set: { ...row, deletedAt: null }`, which
// was stripped and left the row deleted, silently). updatedAt is stamped over anyway.
const UPDATE_STRIPPED = ["_id", "createdAt"]

const pick = (record: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]))

// An update's $set / $setOnInsert as the caller set it; anything else as it is.
function ownedUpdate(update: any): any {
  if (!update || typeof update !== "object" || Array.isArray(update)) return update
  let out: any
  for (const op of ["$set", "$setOnInsert"]) {
    const part = update[op]
    if (!part || typeof part !== "object") continue
    const id = part._id
    const ours = writtenBack.get(part) ?? spreadFrom(part, id)
    if (ours) {
      out ??= { ...update }
      out[op] = withoutOurs(part, pick(ours, UPDATE_STRIPPED))
    }
  }
  return out ?? update
}

// The written-back record of the row `part` was spread from: it carries that row's written-back
// _id, at least one of the stamps written back with it, unchanged — and something besides them
// (a spread brings the row's own fields along). Only an _id and stamps, named one by one, is a
// deliberate reference (`$setOnInsert: { _id: row._id, createdAt: row.createdAt }` for a 1:1
// sidecar born with the parent's id), and is kept: stripped, the sidecar got a fresh id.
function spreadFrom(part: any, id: unknown): Record<string, unknown> | undefined {
  const ours = id && typeof id === "object" ? writtenBackById.get(id) : undefined
  if (!ours) return undefined
  const stampCopied = Object.keys(ours).some((key) => key !== "_id" && part[key] === ours[key])
  const fieldsBeyond = Object.keys(part).some((key) => key !== "_id" && !(ENGINE_STAMPS as readonly string[]).includes(key))
  return stampCopied && fieldsBeyond ? ours : undefined
}

// Marks a db this wrapper made, so wrapping it again returns it as it is.
const WRAPPED = Symbol.for("mogobase.autoStamped")

export function wrapDbWithAutoStamp(db: any): any {
  if (!db || typeof db.model !== "function") return db
  // Already wrapped — ctx.db or ctx.useDatabase(...) handed to a nested ctx.runMutation as its
  // `db`: wrapped again, every write was stamped, validated and Decimal128-encoded twice, and the
  // second validation refused the encoded value of a valid v.decimal128() write.
  if (db[WRAPPED] === true) return db
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === WRAPPED) return true
      if (prop === "model") {
        return (name: string) => wrapCollectionWithAutoStamp(target.model(name), name)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

export { injectUpdatedAt }
