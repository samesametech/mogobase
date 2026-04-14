"use client"
// <MogobaseProvider online handlers> — runtime flag + handler bootstrap for hooks.
// Written with React.createElement to avoid JSX (tsconfig.jsxImportSource is hono/jsx).

import * as React from "react"

export type MogobaseContextValue = {
  online: boolean
  ready: boolean
  clientDB: any | null
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
  // Optional custom DB name for Dexie.
  dbName?: string
  children?: React.ReactNode
}

export function MogobaseProvider(props: MogobaseProviderProps): React.ReactElement {
  const { online, handlers, dbName, children } = props
  const [ready, setReady] = React.useState<boolean>(online ? true : false)
  const [clientDB, setClientDB] = React.useState<any | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function boot() {
      if (online) {
        setReady(true)
        return
      }
      // Lazy-load the RxDB-backed ClientDB so online-only consumers don't
      // ship RxDB/Dexie to the browser.
      const mod = await import("./db")
      const ClientDB = mod.default
      await ClientDB.connect(dbName)
      if (handlers) await handlers()
      // Apply any models registered via runtime.defineModel() in handler files.
      const { getModels } = await import("../runtime/models")
      for (const m of getModels()) {
        await ClientDB.defineModel(m.name, m.schema, m.indexes)
      }
      if (cancelled) return
      setClientDB(ClientDB)
      setReady(true)
    }
    setReady(online ? true : false)
    boot().catch((err) => {
      console.error("[mogobase] offline boot failed:", err)
    })
    return () => {
      cancelled = true
    }
  }, [online, handlers, dbName])

  const value = React.useMemo<MogobaseContextValue>(
    () => ({ online, ready, clientDB }),
    [online, ready, clientDB]
  )

  return React.createElement(MogobaseContext.Provider, { value }, children)
}

export default MogobaseProvider
