// Shared model registry. Handler files call defineModel() from mogobase/runtime
// at module scope; server + client each consume the registry when they boot.

import { z } from "zod/v4"
import type { IndexDescription } from "mongodb"
import { canonical, indexName, keyEntries } from "@/runtime/indexKeys"

// Engine-managed fields. Always considered client-visible regardless of
// `clientFields` allowlist — `_id` is identity, the timestamps are needed for
// caching, ordering, and tombstone detection on the client.
export const CLIENT_ENGINE_FIELDS = ["_id", "createdAt", "updatedAt", "deletedAt"] as const

// MongoDB time-series collection configuration. When set on a model, the
// collection is created with `createCollection(name, { timeseries: {...} })`
// at first defineModel() application. See:
// https://www.mongodb.com/docs/manual/core/timeseries-collections/
export type TimeseriesOptions = {
  // Required. The top-level field whose value is the BSON Date for each
  // measurement. MongoDB rejects inserts where this field is missing or not a
  // Date.
  timeField: string
  // Optional. The top-level field that groups related measurements (e.g.
  // `{ metaField: "sensorId" }`). MongoDB auto-indexes `{metaField, timeField}`.
  metaField?: string
  // Optional bucket granularity. Either supply `granularity`, or the explicit
  // `bucketMaxSpanSeconds` / `bucketRoundingSeconds` pair (6.3+).
  granularity?: "seconds" | "minutes" | "hours"
  bucketMaxSpanSeconds?: number
  bucketRoundingSeconds?: number
  // Optional TTL — auto-expire buckets older than N seconds.
  expireAfterSeconds?: number
}

export type ModelOptions = {
  // MongoDB index definitions, applied via `createIndexes` when the model is
  // first brought online (server: db/index.ts; client: rxdb/watermelon
  // backends). Per-index options (`unique`, `sparse`, `partialFilterExpression`,
  // `expireAfterSeconds`, …) live inside each spec. The engine adds its own
  // `updatedAt`/`deletedAt`/`createdAt` indexes on top unless `stampIndexes` says otherwise.
  indexSpecs?: IndexDescription[]
  // Visibility allowlist. Used by:
  //   - filterClientFields(model, docs) to strip server-only fields from
  //     handler return values in the online flow.
  //   - sync engine pull projection (server-only fields never reach clients).
  //   - sync engine push allowlist (clients can only write fields they can read).
  // Unset → no restriction (every field visible/writable). Engine fields are
  // always included on top of any provided allowlist.
  clientFields?: string[]
  // Opt-in to mogobase sync. Default-deny: sync ops on a model without
  // `sync: true` throw. Independent from `clientFields` so models can be
  // online-only with field filtering, or sync-enabled without restrictions.
  sync?: boolean
  // Opt-in to runtime input validation on writes. When true, the autoStamp
  // wrapper validates insert/update payloads against the model's zod schema
  // and rejects on type mismatch. Default false.
  dbValidation?: boolean
  // Opt-in to a MongoDB time-series collection. Mutually exclusive with `sync`
  // — sync engine throws on timeseries models (no soft-delete tombstone
  // semantics). The autoStamp wrapper skips the `deletedAt:null` field stamp
  // and passes deletes through to native hard-delete.
  timeseries?: TimeseriesOptions
  // The engine's own single-field indexes on `updatedAt`, `deletedAt` and `createdAt`.
  // Default: all three, on every collection — which is how a large collection ends up
  // carrying three indexes that none of its queries use, each one paid for on every write.
  // `false` builds none; an object builds all but the ones set to `false`, e.g.
  // `{ createdAt: false }`. Only what mogobase BUILDS changes: an index already in the
  // database stays until you drop it (see `DB.dropUndeclaredIndexes`). A sync model needs
  // `updatedAt` — every pull filters and sorts on it.
  stampIndexes?: false | { createdAt?: boolean; updatedAt?: boolean; deletedAt?: boolean }
  // The database(s) this model lives in, by name: a list, or a predicate on the name. mogobase
  // builds the model's indexes (and a time-series collection) only there. Unset: every
  // database it is used in, as before. In a multi-database app — an identity database beside
  // per-mode or per-tenant ones, picked per request — building a model everywhere creates an
  // empty "shadow" collection, with all its indexes, in every database the model never uses.
  // A list is also built eagerly, at defineModel, in each database it names. App-wide rule:
  // `DB.setModelDatabases(...)`; a model's own setting wins over it.
  databases?: string[] | ((dbName: string) => boolean)
  [k: string]: any
}

export type ModelDef = {
  name: string
  schema?: any
  indexSpecs?: IndexDescription[]
  clientFields?: string[]
  sync?: boolean
  dbValidation?: boolean
  timeseries?: TimeseriesOptions
  stampIndexes?: ModelOptions["stampIndexes"]
  databases?: ModelOptions["databases"]
  [k: string]: any
}

type Listener = (m: ModelDef) => void | Promise<void>

const KEY = "__mogobase_models__"
const g = globalThis as unknown as Record<
  string,
  {
    models: ModelDef[]
    listeners: Listener[]
    merged?: Map<string, ModelDef>
    mergedCount?: number
    schemaless?: WeakSet<ModelDef>
  }
>
if (!g[KEY]) g[KEY] = { models: [], listeners: [] }
const state = g[KEY]
// Each model's definitions merged (mergeDef), kept up to date as they are registered, so
// latestModelDef is a lookup: re-merging on every registration was O(N²) across N of them.
// Lazily built from `models`, which an older copy of this module may have filled — and built
// again whenever `models` no longer has the length it was merged at (a test clearing the
// registry in place), since every getter reads it.
// Models already warned about syncing without the updatedAt index.
const warnedNoUpdatedAtIndex = new Set<string>()

// The definitions registered without a schema of their own (see mergeDef) — on the shared
// state, like the definitions, so a reloaded copy of this module still knows them.
const schemaless = (state.schemaless ??= new WeakSet<ModelDef>())

function mergedDefs(): Map<string, ModelDef> {
  if (!state.merged || state.mergedCount !== state.models.length) {
    state.merged = new Map()
    for (const m of state.models) state.merged.set(m.name, mergeDef(state.merged.get(m.name), m))
    state.mergedCount = state.models.length
  }
  return state.merged
}

function isZodType(x: any): boolean {
  return !!x && typeof x === "object" && typeof x._def === "object" && typeof x.parse === "function"
}

// The engine's own stamp. The wrapper WRITES epoch milliseconds — a number is
// what the sync checkpoint compares and what a range query on `updatedAt` sorts
// correctly — but a Date is accepted on the way in, because plenty of documents
// arrive carrying one: a migration, a bulk import, a hand-written seed, or a
// caller who simply passed `new Date()`. The stamp is preserved rather than
// overwritten in that case (the doc spread wins in `insertOne`), so refusing it
// here would fail a write whose value the engine had already chosen to keep.
// Readers must therefore accept both — `syncUpdatedAt()` in server/sync.ts
// already does.
const engineTimestamp = () => z.union([z.number(), z.date()])

// Auto-inject sync timestamp fields — handler authors don't have to declare them.
function withSyncFields(schema: any): any {
  const syncFields = {
    createdAt: engineTimestamp(),
    updatedAt: engineTimestamp(),
    deletedAt: engineTimestamp().nullable(),
  }

  if (schema == null) {
    return syncFields
  }

  if (isZodType(schema)) {
    if (typeof (schema as any).extend === "function") {
      try {
        return (schema as any).extend(syncFields)
      } catch {
        // Not a ZodObject; leave as-is.
      }
    }
    return schema
  }

  if (typeof schema === "object") {
    // Plain shape object — sync fields override any consumer-defined timestamp fields.
    return { ...schema, ...syncFields }
  }

  return schema
}

export function defineModel(name: string, schema?: any, options?: ModelOptions | any): void {
  // A bare 3rd arg (an array of index specs, or undefined) is shorthand for
  // `{ indexSpecs: arg }`; an object is the full options bag.
  const opts: ModelOptions =
    options && typeof options === "object" && !Array.isArray(options) ? options : { indexSpecs: options }
  const def: ModelDef = {
    ...opts,
    name,
    schema: withSyncFields(schema),
    clientFields: opts.clientFields,
    sync: opts.sync === true,
    dbValidation: opts.dbValidation === true,
    timeseries: opts.timeseries,
  }
  const merged = mergedDefs() // before the push: in step with `models`
  if (schema == null) schemaless.add(def)
  const model = mergeDef(merged.get(name), def)
  // Checked on the merged definition, before it is registered: one file declaring the model
  // time-series and another opting it into sync gave a merged model that was both, with no error
  // at boot — sync then failed at runtime with "is a time-series collection".
  if (model.timeseries && model.sync === true) {
    throw new Error(
      `[mogobase] defineModel("${name}"): \`sync: true\` is incompatible with \`timeseries\`. ` +
        `Time-series collections have restricted update/delete semantics and cannot participate in soft-delete-based sync.`
    )
  }
  state.models.push(def)
  merged.set(name, model)
  state.mergedCount = state.models.length
  // On the merged definition: the usual split — one file opting out of the stamp indexes,
  // another opting the model into sync — is where it happens, and reading only the definition
  // being registered never warned about it. Once per model.
  if (model.sync === true && model.stampIndexes !== undefined && !getStampIndexFieldsFrom(model.stampIndexes).includes("updatedAt")) {
    if (!warnedNoUpdatedAtIndex.has(name)) {
      warnedNoUpdatedAtIndex.add(name)
      console.warn(`[mogobase] defineModel("${name}"): a sync model without the updatedAt index — every sync pull scans the collection.`)
    }
  }
  for (const l of state.listeners) {
    try {
      void l(def)
    } catch (err) {
      console.error(`[mogobase] defineModel listener failed for ${name}`, err)
    }
  }
}

export function getModels(): ModelDef[] {
  return state.models.slice()
}

// Each field from the latest definition that set it, as the registry's getters read them: a
// field left undefined is not set, and sync / dbValidation count only when true (the getters
// read `=== true`), so a later definition without them does not turn an earlier `true` off.
// A definition given no schema still carries one — withSyncFields' timestamps-only shape — so
// it is not a schema someone set: it does not replace an earlier definition's. Taken as one, a
// file that only opted the model into sync wiped its schema: decimal fields were stored as
// strings, and dbValidation checked only the timestamps.
function mergeDef(prev: ModelDef | undefined, m: ModelDef): ModelDef {
  if (!prev) return m
  const set = Object.fromEntries(
    Object.entries(m).filter(
      ([key, value]) =>
        value !== undefined &&
        !((key === "sync" || key === "dbValidation") && value === false) &&
        !(key === "schema" && schemaless.has(m))
    )
  )
  const merged = { ...prev, ...set } as ModelDef
  // Index specs add up: every distinct spec any definition declares is built, as on main, where
  // each definition was built. The latest replacing the rest lost a file's indexes — a unique
  // index never built on a fresh database, and undeclared (dropUndeclaredIndexes dropped it) on
  // an existing one — when a model's indexes are declared in two files.
  // Whatever either declares, even an empty list: added up only when both had some, a later
  // `indexSpecs: []` replaced every spec declared before with none.
  if (prev.indexSpecs || m.indexSpecs) {
    const earlier = prev.indexSpecs ?? []
    const seen = new Set(earlier.map(specId))
    const onName = new Map<string, IndexDescription[]>()
    const note = (spec: IndexDescription) => onName.set(indexName(spec), [...(onName.get(indexName(spec)) ?? []), spec])
    earlier.forEach(note)
    const added = (m.indexSpecs ?? []).filter((spec) => !seen.has(specId(spec)) && seen.add(specId(spec)))
    for (const spec of added) {
      // Said at registration only where every MongoDB refuses one of the two: one name on two keys
      // ("same name ... different key"). Other pairs MongoDB builds both of, builds as a no-op, or
      // refuses — by version, and by defaults only the server fills in — so the server decides, and
      // onIndexError reports a real refusal in its own words (guessed at here, the warning was wrong
      // both ways, round after round). Once per conflict: mergeDef runs again on a cache rebuild.
      for (const other of onName.get(indexName(spec)) ?? []) {
        if (keyId(other) === keyId(spec)) continue
        const conflict = `${m.name}\u0000${specId(other)}\u0000${specId(spec)}`
        if (warnedIndexConflicts.has(conflict)) continue
        warnedIndexConflicts.add(conflict)
        console.warn(
          `[mogobase] defineModel("${m.name}"): two definitions name an index "${indexName(spec)}" on two keys ` +
            `(${JSON.stringify(other)} and ${JSON.stringify(spec)}): MongoDB refuses one of them on every boot. Rename one.`
        )
      }
      note(spec)
    }
    merged.indexSpecs = [...earlier, ...added]
  }
  return merged
}

const warnedIndexConflicts = new Set<string>()

// An index spec's key, in order (the order is the index) — read as db/indexes reads it.
function keyId(spec: IndexDescription): string {
  return JSON.stringify(keyEntries((spec as any).key))
}

// An index spec's identity: its key in order, its name (its own or the one MongoDB generates), and
// the options that make another index, in any key order (nested ones too: a collation's). Not
// background, v or hidden — the same index either way — and an option set to undefined, or
// unique / sparse false, is none. Counted apart, one index spelled two ways ({ key } and
// { key, name: "a_1" }, or one with background) was kept twice: a fresh collection's batch was
// refused whole ("Cannot build two identical indexes"), and every spec was built one by one.
const NOT_IDENTITY = new Set(["key", "name", "background", "v", "hidden"])
const FALSE_IS_DEFAULT = new Set(["unique", "sparse"])
function specId(spec: IndexDescription): string {
  const options: Record<string, unknown> = {}
  for (const [option, value] of Object.entries(spec as any)) {
    if (NOT_IDENTITY.has(option) || value === undefined || (value === false && FALSE_IS_DEFAULT.has(option))) continue
    options[option] = value
  }
  return `${keyId(spec)}\u0000${indexName(spec)}\u0000${canonical(options)}`
}

/** One model's definitions, merged (mergeDef): for building it as the registry reads it. */
export function latestModelDef(name: string): ModelDef | undefined {
  return mergedDefs().get(name)
}

/** Every model's definitions, merged, once per model: for replaying registrations. */
export function latestModelDefs(): ModelDef[] {
  return [...mergedDefs().values()]
}

// Wrap a model def's flat `indexSpecs` into the `{ indexSpecs }` envelope the
// db + client backends pass to `createIndexes`. Single source of truth for both
// bridges (server connect() and client provider) so they can't drift. Returns
// undefined when the model declares no custom indexes — the engine still adds
// its sync-checkpoint indexes on top.
export function indexEnvelope(def: ModelDef): { indexSpecs: IndexDescription[] } | undefined {
  return def.indexSpecs?.length ? { indexSpecs: def.indexSpecs } : undefined
}

// Multiple defineModel() calls for the same name are tolerated (e.g. online +
// offline handler files registering the same collection). The most recent
// entry with the requested config wins — read from the merged definition
// (mergeDef), kept current as definitions arrive, so a getter is one map
// lookup: they used to scan every definition, once per ctx.watch and write.
const latest = (name: string): ModelDef | undefined => mergedDefs().get(name)

export function getClientFields(name: string): string[] | undefined {
  return latest(name)?.clientFields
}

export function isSyncEnabled(name: string): boolean {
  return latest(name)?.sync === true
}

export function isValidationEnabled(name: string): boolean {
  return latest(name)?.dbValidation === true
}

export function getTimeseriesOptions(name: string): TimeseriesOptions | undefined {
  return latest(name)?.timeseries
}

export function isTimeseries(name: string): boolean {
  return !!getTimeseriesOptions(name)
}

// The engine's stamp indexes, in the order they have always been built.
export const STAMP_INDEX_FIELDS = ["updatedAt", "deletedAt", "createdAt"] as const
export type StampIndexField = (typeof STAMP_INDEX_FIELDS)[number]

function getStampIndexFieldsFrom(setting: ModelOptions["stampIndexes"]): StampIndexField[] {
  if (setting === false) return []
  return STAMP_INDEX_FIELDS.filter((field) => !setting || setting[field] !== false)
}

/** Which engine stamp indexes a model builds — all three unless its `stampIndexes` says otherwise. */
export function getStampIndexFields(name: string): StampIndexField[] {
  return getStampIndexFieldsFrom(latest(name)?.stampIndexes)
}

/** The model's own `databases` setting, if it has one. */
export function getModelDatabases(name: string): ModelOptions["databases"] {
  return latest(name)?.databases
}

const shapeSchemas = new WeakMap<object, any>()

// Resolve the latest stored schema for a model into a parsable zod schema.
// `defineModel` accepts either a ZodObject or a plain `{field: zodType}` shape;
// we normalize the shape case into `z.object(...)` so callers can `.parse()`
// or `.partial()` uniformly. Returns undefined if no schema was registered.
export function getModelZodSchema(name: string): any {
  const raw = latest(name)?.schema
  if (raw == null) return undefined
  if (isZodType(raw)) return raw
  if (typeof raw === "object") {
    // Built once per shape: rebuilt on every lookup, a dbValidation model made a new z.object per
    // write.
    let built = shapeSchemas.get(raw)
    if (built === undefined) {
      try {
        built = z.object(raw as any)
      } catch {
        built = null
      }
      shapeSchemas.set(raw, built)
    }
    return built ?? undefined
  }
  return undefined
}

function projectToClientFields(doc: any, allowed: Set<string>): any {
  if (!doc || typeof doc !== "object") return doc
  const out: any = {}
  for (const k of Object.keys(doc)) {
    if (allowed.has(k)) out[k] = doc[k]
  }
  return out
}

// Strip server-only fields from handler return values. Looks up the model's
// `clientFields` allowlist, projects each doc to allowlist + engine fields.
// Pass-through if the model has no allowlist configured.
//
// Handles three input shapes:
//   - single document object → projected document
//   - array of documents → array of projected documents
//   - paginated result `{ results: [...], hasNext, ... }` → same shape with
//     `results` projected (other fields preserved)
export function filterClientFields<T = any>(model: string, input: T): T {
  if (input == null) return input
  const fields = getClientFields(model)
  if (!fields) return input
  const allowed = new Set<string>([...CLIENT_ENGINE_FIELDS, ...fields])

  if (Array.isArray(input)) {
    return input.map((d) => projectToClientFields(d, allowed)) as any
  }
  if (typeof input === "object") {
    const obj = input as any
    if (Array.isArray(obj.results)) {
      return { ...obj, results: obj.results.map((d: any) => projectToClientFields(d, allowed)) } as any
    }
    return projectToClientFields(obj, allowed) as any
  }
  return input
}

export function onModel(listener: Listener): () => void {
  state.listeners.push(listener)
  for (const m of state.models) {
    try {
      void listener(m)
    } catch (err) {
      console.error(`[mogobase] onModel replay failed for ${m.name}`, err)
    }
  }
  return () => {
    const i = state.listeners.indexOf(listener)
    if (i >= 0) state.listeners.splice(i, 1)
  }
}
