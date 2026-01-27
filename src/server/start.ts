import { serve } from "@hono/node-server"
import app from "@/server/hono"

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.MOGOBASE_PORT) || 4000,
})

// graceful shutdown
process.on("SIGINT", () => {
  server.close()
  process.exit(0)
})
process.on("SIGTERM", () => {
  server.close((err: any) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    process.exit(0)
  })
})
