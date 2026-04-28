import { useEffect, useState } from "react"
import { useMogobase } from "../provider"
import { runQuery } from "../../runtime"

function wsUrl(): string {
  const override = process.env.NEXT_MOGOBASE_URL || process.env.MOGOBASE_URL
  if (override) return override.replace(/^http/, "ws") + "/ws"
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${window.location.host}/ws`
  }
  return "ws://localhost:3000/ws"
}

function safeCloseWS(ws: WebSocket | null | undefined) {
  if (!ws) return
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener("open", () => ws.close(), { once: true })
  } else if (ws.readyState === WebSocket.OPEN) {
    ws.close()
  }
}

function useQuery(name: string, args?: any) {
  const { online, sync, ready, clientDB } = useMogobase()
  const [data, setData] = useState<any>(undefined)

  const argsKey = typeof args === "object" ? JSON.stringify(args) : args

  useEffect(() => {
    setData(undefined)
    if (argsKey === "skip") return
    if (online && !sync) {
      const ws = new WebSocket(wsUrl())

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "query", name, args }))
      })

      ws.addEventListener("message", (event) => {
        const rs = JSON.parse(event.data)
        if (rs.type === "QueryResult") {
          if (rs.success) setData(rs.data)
          else console.error(rs.error)
        }
      })

      ws.addEventListener("error", (event) => {
        console.error(`[mogobase] useQuery(${name}) ws error`, event)
      })

      ws.addEventListener("close", (event) => {
        if (!event.wasClean) {
          console.warn(`[mogobase] useQuery(${name}) ws closed`, event.code, event.reason)
        }
      })

      return () => {
        safeCloseWS(ws)
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
