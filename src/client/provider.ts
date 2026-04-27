"use client"
// <MogobaseProvider online clientDB handlers> — runtime flag + handler bootstrap for hooks.
// Written with React.createElement to avoid JSX (tsconfig.jsxImportSource is hono/jsx).

import * as React from "react"

// Structural type for the offline client DB. Defined here so importing the type
// does NOT pull rxdb / watermelon into the bundle. The concrete backend modules
// (`mogobase/client-db`, `mogobase/client-db/watermelon`) export richer types
// for consumers that want them.
export type MogobaseClientDB = {
  connect: (dbName?: string) => Promise<unknown>
  defineModel: (name: string, schema?: unknown, indexes?: unknown) => Promise<unknown> | unknown
  model: (name: string) => unknown
  observeChanges: (name: string) => {
    subscribe: (fn: () => void) => { unsubscribe: () => void }
  }
}

export type MogobaseContextValue = {
  online: boolean
  ready: boolean
  clientDB: MogobaseClientDB | null
}

export const MogobaseContext = React.createContext<MogobaseContextValue | null>(null)

export function useMogobase(): MogobaseContextValue {
  const ctx = React.useContext(MogobaseContext)
  if (!ctx) {
    throw new Error(
      "[mogobase] MogobaseContext not found — wrap your app in <MogobaseProvider>."
    )
  }
  return ctx
}

export type MogobaseProviderProps = {
  online: boolean
  // Async loader that registers handlers on the runtime singleton. Typical:
  //   handlers={() => import("@/mogobase")}
  handlers?: () => Promise<unknown>
  // Optional custom DB name for the offline store.
  dbName?: string
  // Required when online={false}. Import from "mogobase/client-db" (RxDB) or
  // "mogobase/client-db/watermelon" (WatermelonDB) and pass the default export.
  clientDB?: MogobaseClientDB
  children?: React.ReactNode
}

export function MogobaseProvider(props: MogobaseProviderProps): React.ReactElement {
  const { online, handlers, dbName, clientDB, children } = props
  const [ready, setReady] = React.useState<boolean>(online ? true : false)
  const [resolvedDB, setResolvedDB] = React.useState<MogobaseClientDB | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function boot() {
      if (online) {
        setReady(true)
        return
      }
      if (!clientDB) {
        throw new Error(
          "[mogobase] <MogobaseProvider online={false}> requires a `clientDB` prop. " +
            "Import from 'mogobase/client-db' (RxDB) or 'mogobase/client-db/watermelon' " +
            "and pass it as the prop."
        )
      }
      await clientDB.connect(dbName)
      if (handlers) await handlers()
      // Apply any models registered via runtime.defineModel() in handler files.
      const { getModels } = await import("../runtime/models")
      for (const m of getModels()) {
        await clientDB.defineModel(m.name, m.schema, m.indexes)
      }
      if (cancelled) return
      setResolvedDB(clientDB)
      setReady(true)
    }
    setReady(online ? true : false)
    boot().catch((err) => {
      console.error("[mogobase] offline boot failed:", err)
    })
    return () => {
      cancelled = true
    }
  }, [online, handlers, dbName, clientDB])

  const value = React.useMemo<MogobaseContextValue>(
    () => ({ online, ready, clientDB: resolvedDB }),
    [online, ready, resolvedDB]
  )

  return React.createElement(MogobaseContext.Provider, { value }, children)
}

export default MogobaseProvider
