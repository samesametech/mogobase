import { useCallback, useEffect, useRef, useState } from "react"

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
  paginationData: PaginationData = {
    pageSize: 10,
  }
) {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState<boolean>(false)

  const nextPage = useRef<string>("")
  const previousPage = useRef<string>("")
  const ws = useRef<WebSocket | null>(null)

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
  }, [name, JSON.stringify(args), paginationData])

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
  }, [name, JSON.stringify(args), paginationData])

  useEffect(() => {
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
  }, [fetchNextPage])

  const loadNext = useCallback(() => {
    if (nextPage.current) {
      fetchNextPage()
    }
  }, [fetchNextPage])

  const loadPrevious = useCallback(() => {
    if (previousPage.current) {
      fetchPreviousPage()
    }
  }, [fetchPreviousPage])

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
