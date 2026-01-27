import { serve } from "@hono/node-server"
import app from "@/server/hono"
import path from "path"
import ws from "@/server/ws"

import fs from "fs"
const cwd = process.cwd()
const mogobaseFolder = path.resolve(cwd, "./mogobase")

let server: any

const port = Number(process.env.MOGOBASE_PORT) || 4000

const files = fs.readdirSync(mogobaseFolder)
for (const file of files) {
  if (!file.endsWith(".ts")) continue
  const filePath = path.join(mogobaseFolder, file)
  const module = (await import(filePath)) as any
  if (typeof module.default === "function") {
    module.default(app)
  }
}

server = serve({
  fetch: app.fetch,
  port,
})
console.log(`Mogobase dev server running on port ${port}`)

ws.injectWebSocket(server)

// graceful shutdown
process.on("SIGINT", () => {
  server.close()
  process.exit(0)
})
process.on("SIGTERM", () => {
  if (!server) return
  server.close((err: any) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    process.exit(0)
  })
})
