"use client"
// <MogobaseProvider online clientDB handlers sync> — runtime flag + handler bootstrap for hooks.
// Written with React.createElement to avoid JSX (tsconfig.jsxImportSource is hono/jsx).

import * as React from "react"

import type { SyncHandle, SyncOptions } from "./sync-types"

export type { SyncHandle, SyncOptions } from "./sync-types"

// Structural type for the offline client DB. Defined here so importing the type
// does NOT pull rxdb / watermelon into the bundle. The concrete backend modules
// (`mogobase/client-db`, `mogobase/client-db/watermelon`) export richer types
// for consumers that want them. Parameters use `any` (not `unknown`) so concrete
// backends with stricter signatures (Mongo IndexDescription[], etc.) satisfy
// this contract — function parameters are contravariant under strict checks.
export type MogobaseClientDB = {
  connect: (dbName?: string) => Promise<any>
  defineModel: (name: string, schema?: any, indexes?: any) => Promise<any> | any
  model: (name: string) => any
  observeChanges: (name: string) => {
    subscribe: (fn: () => void) => { unsubscribe: () => void }
  }
  startSync?: (options?: SyncOptions) => Promise<SyncHandle>
  stopSync?: () => Promise<void>
}

export type MogobaseContextValue = {
  online: boolean
  sync: boolean
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
  // Required when online={false} OR sync={true}. Import from "mogobase/client-db"
  // (RxDB) or "mogobase/client-db/watermelon" (WatermelonDB) and pass the
  // default export.
  clientDB?: MogobaseClientDB
  // When true (and online), hooks read/write through clientDB and a background
  // engine continuously replicates between clientDB and MongoDB. Requires
  // `clientDB` to be provided. Memoize `syncOptions` (or pass a stable
  // reference) — it's part of the boot effect's dep array.
  sync?: boolean
  syncOptions?: SyncOptions
  children?: React.ReactNode
}

export function MogobaseProvider(props: MogobaseProviderProps): React.ReactElement {
  const { online, handlers, dbName, clientDB, sync, syncOptions, children } = props
  const useClientDB = !online || (online && !!sync)
  const [ready, setReady] = React.useState<boolean>(useClientDB ? false : true)
  const [resolvedDB, setResolvedDB] = React.useState<MogobaseClientDB | null>(null)
  const syncHandleRef = React.useRef<SyncHandle | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function boot() {
      if (online && !sync) {
        setReady(true)
        return
      }
      if (!clientDB) {
        throw new Error(
          "[mogobase] <MogobaseProvider> requires a `clientDB` prop when offline " +
            "or when `sync={true}`. Import from 'mogobase/client-db' (RxDB) or " +
            "'mogobase/client-db/watermelon' (WatermelonDB) and pass it as the prop."
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

      if (online && sync) {
        if (typeof clientDB.startSync !== "function") {
          throw new Error(
            "[mogobase] sync={true} requires a clientDB that implements startSync(). " +
              "RxDB and WatermelonDB backends both support sync."
          )
        }
        try {
          const handle = await clientDB.startSync(syncOptions || {})
          if (cancelled) {
            await handle.cancel().catch(() => {})
          } else {
            syncHandleRef.current = handle
          }
        } catch (err) {
          console.error("[mogobase] startSync failed:", err)
        }
      }
    }
    setReady(useClientDB ? false : true)
    boot().catch((err) => {
      console.error("[mogobase] boot failed:", err)
    })
    return () => {
      cancelled = true
      const h = syncHandleRef.current
      syncHandleRef.current = null
      if (h) {
        h.cancel().catch(() => {})
      }
    }
  }, [online, sync, handlers, dbName, clientDB, syncOptions, useClientDB])

  const value = React.useMemo<MogobaseContextValue>(
    () => ({ online, sync: !!sync, ready, clientDB: resolvedDB }),
    [online, sync, ready, resolvedDB]
  )

  return React.createElement(MogobaseContext.Provider, { value }, children)
}

export default MogobaseProvider
