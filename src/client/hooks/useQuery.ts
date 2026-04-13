import { useEffect, useState } from "react"

function wsUrl(): string {
  const override = process.env.NEXT_MOGOBASE_URL || process.env.MOGOBASE_URL
  if (override) return override.replace(/^http/, "ws") + "/ws"
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${window.location.host}/ws`
  }
  return "ws://localhost:3000/ws"
}

function useQuery(name: string, args?: any) {
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    const ws = new WebSocket(wsUrl())

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "query",
          name,
          args,
        })
      )
    })

    ws.addEventListener("message", (event) => {
      const rs = JSON.parse(event.data)
      if (rs.type === "QueryResult") {
        if (rs.success) {
          setData(rs.data)
        } else {
          console.error(rs.error)
        }
      }
    })

    return () => {
      ws.close()
      setData(null)
    }
  }, [name, JSON.stringify(args)])

  return data
}

export default useQuery
