// Shared model registry. Handler files call defineModel() from mogobase/runtime
// at module scope; server + client each consume the registry when they boot.

import { z } from "zod/v4"

export type ModelDef = {
  name: string
  schema?: any
  indexes?: any
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

export function defineModel(name: string, schema?: any, indexes?: any): void {
  const def: ModelDef = { name, schema: withSyncFields(schema), indexes }
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
