// Shared model registry. Handler files call defineModel() from mogobase/runtime
// at module scope; server + client each consume the registry when they boot.

import { z } from "zod/v4"

// Engine-managed fields. Always considered client-visible regardless of
// `clientFields` allowlist — `_id` is identity, the timestamps are needed for
// caching, ordering, and tombstone detection on the client.
export const CLIENT_ENGINE_FIELDS = ["_id", "createdAt", "updatedAt", "deletedAt"] as const

export type ModelOptions = {
  indexes?: any
  indexSpecs?: any
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
  [k: string]: any
}

export type ModelDef = {
  name: string
  schema?: any
  indexes?: any
  indexSpecs?: any
  clientFields?: string[]
  sync?: boolean
  dbValidation?: boolean
  [k: string]: any
}

type Listener = (m: ModelDef) => void | Promise<void>

const KEY = "__mogobase_models__"
const g = globalThis as unknown as Record<string, { models: ModelDef[]; listeners: Listener[] }>
if (!g[KEY]) g[KEY] = { models: [], listeners: [] }
const state = g[KEY]

function isZodType(x: any): boolean {
  return !!x && typeof x === "object" && typeof x._def === "object" && typeof x.parse === "function"
}

// Auto-inject sync timestamp fields. Sync correctness depends on these being
// present and numeric — handler authors don't have to declare them.
function withSyncFields(schema: any): any {
  const syncFields = {
    createdAt: z.number(),
    updatedAt: z.number(),
    deletedAt: z.number().nullable(),
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
  const opts: ModelOptions = (options && typeof options === "object" && !Array.isArray(options)) ? options : { indexes: options }
  const def: ModelDef = {
    ...opts,
    name,
    schema: withSyncFields(schema),
    clientFields: opts.clientFields,
    sync: opts.sync === true,
    dbValidation: opts.dbValidation === true,
  }
  state.models.push(def)
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

// Multiple defineModel() calls for the same name are tolerated (e.g. online +
// offline handler files registering the same collection). The most recent
// entry with the requested config wins.
function findLatest<T>(name: string, pick: (m: ModelDef) => T | undefined): T | undefined {
  for (let i = state.models.length - 1; i >= 0; i--) {
    const m = state.models[i]
    if (m.name !== name) continue
    const v = pick(m)
    if (v !== undefined) return v
  }
  return undefined
}

export function getClientFields(name: string): string[] | undefined {
  return findLatest(name, (m) => m.clientFields)
}

export function isSyncEnabled(name: string): boolean {
  return findLatest(name, (m) => (m.sync === true ? true : undefined)) === true
}

export function isValidationEnabled(name: string): boolean {
  return findLatest(name, (m) => (m.dbValidation === true ? true : undefined)) === true
}

// Resolve the latest stored schema for a model into a parsable zod schema.
// `defineModel` accepts either a ZodObject or a plain `{field: zodType}` shape;
// we normalize the shape case into `z.object(...)` so callers can `.parse()`
// or `.partial()` uniformly. Returns undefined if no schema was registered.
export function getModelZodSchema(name: string): any {
  const raw = findLatest(name, (m) => m.schema)
  if (raw == null) return undefined
  if (isZodType(raw)) return raw
  if (typeof raw === "object") {
    try {
      return z.object(raw as any)
    } catch {
      return undefined
    }
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
