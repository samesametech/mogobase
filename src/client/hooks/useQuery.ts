import { hc } from "hono/client"
import { useEffect, useState } from "react"

const client = hc(process.env.NEXT_MOGOBASE_URL || process.env.MOGOBASE_URL || "http://localhost:4000")

function useQuery(name: string, args?: any) {
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    const ws = client.ws.$ws(0)

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
    }
  }, [name, JSON.stringify(args)])

  return data
}

export default useQuery
