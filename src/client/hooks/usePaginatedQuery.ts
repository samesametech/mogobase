import { useCallback, useEffect, useRef, useState } from "react"
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

const mergeArray = (arr1: any[], arr2: any[], key: string, insert: boolean = false) => {
  const result = [...arr1]
  for (const item of arr2) {
    const foundIndex = result.findIndex((i) => i[key] === item[key])
    if (foundIndex >= 0) {
      result[foundIndex] = item
      continue
    } else if (insert) {
      result.push(item)
    }
  }
  return result
}

function safeCloseWS(ws: WebSocket | null | undefined) {
  if (!ws) return
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener("open", () => ws.close(), { once: true })
  } else if (ws.readyState === WebSocket.OPEN) {
    ws.close()
  }
}

type PaginationData = {
  pageSize: number
  sortAscending?: boolean
  sortCaseInsensitive?: boolean
  /** Accepted for backward compatibility; the server handler controls the actual paginatedField via MongoPaging.find. */
  paginatedField?: string
}

function usePaginatedQuery(name: string, args?: any, paginationData: PaginationData = { pageSize: 10 }) {
  const { online, sync, ready, clientDB } = useMogobase()
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [hasNext, setHasNext] = useState<boolean>(false)
  const [hasPrevious, setHasPrevious] = useState<boolean>(false)

  const ws = useRef<WebSocket | null>(null)
  const sortAscending = paginationData.sortAscending ?? true

  const argsKey = typeof args === "object" ? JSON.stringify(args) : args

  const sendLoadNext = useCallback(() => {
    if (ws.current?.readyState !== WebSocket.OPEN) return
    setLoading(true)
    ws.current.send(JSON.stringify({ type: "paginated-query-load-next" }))
  }, [])

  const sendLoadPrevious = useCallback(() => {
    if (ws.current?.readyState !== WebSocket.OPEN) return
    setLoading(true)
    ws.current.send(JSON.stringify({ type: "paginated-query-load-previous" }))
  }, [])

  // --- Offline path state ---
  const offlineNextRef = useRef<string>("")
  const offlinePrevRef = useRef<string>("")
  const offlineRunRef = useRef<((direction?: "next" | "previous") => Promise<void>) | null>(null)

  useEffect(() => {
    if (argsKey === "skip") return
    if (online && !sync) {
      const wsLocal = new WebSocket(wsUrl())
      ws.current = wsLocal
      setLoading(true)

      wsLocal.addEventListener("open", () => {
        if (ws.current !== wsLocal) return
        wsLocal.send(
          JSON.stringify({
            type: "paginated-query",
            name,
            args: {
              ...(args || {}),
              paginationOpts: {
                limit: paginationData.pageSize,
                sortAscending,
                sortCaseInsensitive: paginationData.sortCaseInsensitive ?? false,
              },
            },
          })
        )
      })

      wsLocal.addEventListener("message", (event) => {
        const rs = JSON.parse(event.data)
        if (rs.type === "PaginatedQueryResult") {
          setLoading(false)
          if (rs.success) {
            const { results, hasPrevious: hp, hasNext: hn } = rs.data
            setHasNext(!!hn)
            setHasPrevious(!!hp)
            setData(results || [])
          } else {
            console.error(rs.error)
          }
        } else if (rs.type === "PaginatedQueryPage") {
          setLoading(false)
          if (rs.success) {
            const { results, hasPrevious: hp, hasNext: hn } = rs.data
            if (rs.direction === "next") {
              setHasNext(!!hn)
              setData((d) => mergeArray(d, results, "_id", true))
            } else {
              setHasPrevious(!!hp)
              setData((d) => {
                const existingIds = new Set(d.map((x) => x._id))
                const prepend = (results || []).filter((x: any) => !existingIds.has(x._id))
                return [...prepend, ...d]
              })
            }
          } else {
            console.error(rs.error)
          }
        }
      })

      wsLocal.addEventListener("error", (event) => {
        setLoading(false)
        console.error(`[mogobase] usePaginatedQuery(${name}) ws error`, event)
      })

      wsLocal.addEventListener("close", (event) => {
        setLoading(false)
        if (!event.wasClean) {
          console.warn(`[mogobase] usePaginatedQuery(${name}) ws closed`, event.code, event.reason)
        }
      })

      return () => {
        if (ws.current === wsLocal) ws.current = null
        safeCloseWS(wsLocal)
        setData([])
        setHasNext(false)
        setHasPrevious(false)
        setLoading(false)
      }
    }

    // Offline path.
    if (!ready || !clientDB) return
    let cancelled = false
    let subs: Array<{ unsubscribe: () => void }> = []

    const run = async (direction?: "next" | "previous") => {
      setLoading(true)
      for (const s of subs) s.unsubscribe()
      subs = []
      const seen = new Set<string>()
      const paginationOpts: any = {
        limit: paginationData.pageSize,
        sortAscending,
        sortCaseInsensitive: paginationData.sortCaseInsensitive ?? false,
      }
      if (direction === "next" && offlineNextRef.current) paginationOpts.next = offlineNextRef.current
      if (direction === "previous" && offlinePrevRef.current) paginationOpts.previous = offlinePrevRef.current

      try {
        const rs = await runQuery(
          name,
          { ...(args || {}), paginationOpts },
          { db: clientDB, watch: (modelName: string) => seen.add(modelName) }
        )
        if (cancelled) return
        if (rs && Array.isArray(rs.results)) {
          const { results, previous, hasPrevious: hp, next, hasNext: hn } = rs
          offlineNextRef.current = hn ? next : ""
          offlinePrevRef.current = hp ? previous : ""
          setHasNext(!!hn)
          setHasPrevious(!!hp)
          setData((d) => (direction ? mergeArray(d, results, "_id", true) : results))
        }
      } catch (err) {
        console.error(err)
      } finally {
        setLoading(false)
      }

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
    offlineRunRef.current = run
    run()

    return () => {
      cancelled = true
      for (const s of subs) s.unsubscribe()
      offlineRunRef.current = null
      offlineNextRef.current = ""
      offlinePrevRef.current = ""
      setData([])
      setHasNext(false)
      setHasPrevious(false)
      setLoading(false)
    }
  }, [online, sync, ready, name, argsKey, paginationData.pageSize, sortAscending, paginationData.sortCaseInsensitive])

  const loadNext = useCallback(() => {
    if (!online || sync) {
      if (offlineNextRef.current) offlineRunRef.current?.("next")
      return
    }
    if (hasNext) sendLoadNext()
  }, [online, sync, hasNext, sendLoadNext])

  const loadPrevious = useCallback(() => {
    if (!online || sync) {
      if (offlinePrevRef.current) offlineRunRef.current?.("previous")
      return
    }
    if (hasPrevious) sendLoadPrevious()
  }, [online, sync, hasPrevious, sendLoadPrevious])

  return {
    results: data,
    hasNext,
    loadNext,
    hasPrevious,
    loadPrevious,
    isLoading: loading,
  }
}

export default usePaginatedQuery
