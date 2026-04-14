import { useMogobase } from "../provider"
import { invokeMutation } from "../runtime/invoke"

const apiBase = process.env.NEXT_MOGOBASE_URL || process.env.MOGOBASE_URL || ""
const apiUrl = `${apiBase}/api/handlers`

function useMutation(name: string) {
  const { online, clientDB } = useMogobase()

  return async (args?: any) => {
    if (online) {
      const rs = await fetch(apiUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, args }),
      })
      return await rs.json()
    }
    if (!clientDB) throw new Error("[mogobase] offline client DB not ready")
    return await invokeMutation(name, args, { db: clientDB })
  }
}

export default useMutation
