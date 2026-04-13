const apiBase = process.env.NEXT_MOGOBASE_URL || process.env.MOGOBASE_URL || ""
const apiUrl = `${apiBase}/api/handlers`

function useMutation(name: string) {
  return async (args?: any) => {
    const rs = await fetch(apiUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        args,
      }),
    })
    const data = await rs.json()
    return data
  }
}

export default useMutation
