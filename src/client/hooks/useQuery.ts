import { useEffect, useState } from "react"
import { useMogobase } from "../provider"
import { runQuery } from "../../runtime"
import { openResilientWs } from "./wsConnect"

function useQuery(name: string, args?: any) {
  const { online, sync, ready, clientDB } = useMogobase()
  const [data, setData] = useState<any>(undefined)

  const argsKey = typeof args === "object" ? JSON.stringify(args) : args

  useEffect(() => {
    setData(undefined)
    if (argsKey === "skip") return
    if (online && !sync) {
      const conn = openResilientWs({
        label: `useQuery(${name})`,
        subscribeMsg: () => ({ type: "query", name, args }),
        onMessage: (rs) => {
          if (rs.type === "QueryResult") {
            if (rs.success) setData(rs.data)
            else console.error(rs.error)
          }
        },
      })

      return () => {
        conn.close()
        setData(undefined)
      }
    }

    // Offline: run the handler locally; re-run whenever any watched model emits.
    if (!ready || !clientDB) return

    let cancelled = false
    let subs: Array<{ unsubscribe: () => void }> = []

    const run = async () => {
      for (const s of subs) s.unsubscribe()
      subs = []
      const seen = new Set<string>()
      const rs = await runQuery(name, args, {
        db: clientDB,
        watch: (modelName: string) => seen.add(modelName),
      })
      if (cancelled) return
      setData(rs === undefined ? null : rs)
      for (const m of seen) {
        try {
          const sub = (clientDB as any).observeChanges(m).subscribe(() => {
            if (!cancelled) run()
          })
          subs.push(sub)
        } catch (err) {
          console.warn(`[mogobase] watch: model ${m} not available`, err)
        }
      }
    }

    run().catch((err) => console.error(err))

    return () => {
      cancelled = true
      for (const s of subs) s.unsubscribe()
      setData(undefined)
    }
  }, [online, sync, ready, name, argsKey])

  return data
}

export default useQuery
