import { useCallback, useEffect, useRef, useState } from "react"
import { useMogobase } from "../provider"
import { invokeQuery } from "../runtime/invoke"

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

type PaginationData = {
  pageSize: number
  sortAscending?: boolean
  sortCaseInsensitive?: boolean
}

function usePaginatedQuery(
  name: string,
  args?: any,
  paginationData: PaginationData = { pageSize: 10 }
) {
  const { online, ready, clientDB } = useMogobase()
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState<boolean>(false)

  const nextPage = useRef<string>("")
  const previousPage = useRef<string>("")
  const ws = useRef<WebSocket | null>(null)

  const argsKey = JSON.stringify(args)

  // --- Online (WebSocket) path ---
  const fetchNextPage = useCallback(() => {
    setLoading(true)
    ws.current?.send(
      JSON.stringify({
        type: "paginated-query",
        name,
        args: {
          ...(args || {}),
          paginationArgs: {
            limit: paginationData.pageSize,
            next: nextPage.current || undefined,
            sortAscending: paginationData.sortAscending ?? true,
            sortCaseInsensitive: paginationData.sortCaseInsensitive ?? false,
          },
        },
      })
    )
  }, [name, argsKey, paginationData])

  const fetchPreviousPage = useCallback(() => {
    setLoading(true)
    ws.current?.send(
      JSON.stringify({
        type: "paginated-query",
        name,
        args: {
          ...(args || {}),
          paginationArgs: {
            limit: paginationData.pageSize,
            previous: previousPage.current || undefined,
            sortAscending: paginationData.sortAscending ?? true,
            sortCaseInsensitive: paginationData.sortCaseInsensitive ?? false,
          },
        },
      })
    )
  }, [name, argsKey, paginationData])

  // --- Offline path state ---
  const offlineNextRef = useRef<string>("")
  const offlinePrevRef = useRef<string>("")
  const offlineRunRef = useRef<((direction?: "next" | "previous") => Promise<void>) | null>(null)

  useEffect(() => {
    if (online) {
      ws.current = new WebSocket(wsUrl())

      ws.current.addEventListener("open", () => {
        fetchNextPage()
      })

      ws.current.addEventListener("message", (event) => {
        setLoading(false)
        const rs = JSON.parse(event.data)
        if (rs.type === "PaginatedQueryResult") {
          if (rs.success) {
            const { results, previous, hasPrevious, next, hasNext } = rs.data
            nextPage.current = hasNext ? next : ""
            previousPage.current = hasPrevious ? previous : ""
            setData((d) => mergeArray(d, results, "_id", true))
          } else {
            console.error(rs.error)
          }
        } else if (rs.type === "UpdateDoc") {
          setData((d) => mergeArray(d, [rs.data], "_id"))
        }
      })

      return () => {
        ws.current?.close()
        nextPage.current = ""
        previousPage.current = ""
        setData([])
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
      const paginationArgs: any = {
        limit: paginationData.pageSize,
        sortAscending: paginationData.sortAscending ?? true,
        sortCaseInsensitive: paginationData.sortCaseInsensitive ?? false,
      }
      if (direction === "next" && offlineNextRef.current) paginationArgs.next = offlineNextRef.current
      if (direction === "previous" && offlinePrevRef.current) paginationArgs.previous = offlinePrevRef.current

      try {
        const { data: rs } = await invokeQuery(
          name,
          { ...(args || {}), paginationArgs },
          { db: clientDB, onWatch: (w) => seen.add(w.modelName) }
        )
        if (cancelled) return
        if (rs && Array.isArray(rs.results)) {
          const { results, previous, hasPrevious, next, hasNext } = rs
          offlineNextRef.current = hasNext ? next : ""
          offlinePrevRef.current = hasPrevious ? previous : ""
          nextPage.current = offlineNextRef.current
          previousPage.current = offlinePrevRef.current
          setData((d) => (direction ? mergeArray(d, results, "_id", true) : results))
        }
      } catch (err) {
        console.error(err)
      } finally {
        setLoading(false)
      }

      for (const m of seen) {
        try {
          const rx = (clientDB as any).model(m)._rx
          const sub = rx.$.subscribe(() => {
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
      nextPage.current = ""
      previousPage.current = ""
      setData([])
      setLoading(false)
    }
  }, [online, ready, name, argsKey, paginationData.pageSize, fetchNextPage])

  const loadNext = useCallback(() => {
    if (!online) {
      if (offlineNextRef.current) offlineRunRef.current?.("next")
      return
    }
    if (nextPage.current) fetchNextPage()
  }, [online, fetchNextPage])

  const loadPrevious = useCallback(() => {
    if (!online) {
      if (offlinePrevRef.current) offlineRunRef.current?.("previous")
      return
    }
    if (previousPage.current) fetchPreviousPage()
  }, [online, fetchPreviousPage])

  return {
    results: data,
    hasNext: !!nextPage.current,
    loadNext,
    hasPrevious: !!previousPage.current,
    loadPrevious,
    isLoading: loading,
  }
}

export default usePaginatedQuery
