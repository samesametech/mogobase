// Shared model registry. Handler files call defineModel() from mogobase/runtime
// at module scope; server + client each consume the registry when they boot.

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

export function defineModel(name: string, schema?: any, indexes?: any): void {
  const def: ModelDef = { name, schema, indexes }
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
