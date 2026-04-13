// Copy this file to the ROOT of your Next.js project as `server.ts`.
// Run with: npx tsx server.ts (dev) or build & node server.js (prod).
//
// Update package.json scripts:
//   "dev":   "tsx server.ts",
//   "build": "next build",
//   "start": "NODE_ENV=production tsx server.ts"
//
// Your mogobase handler files live in ./mogobase/*.ts — this server loads
// each of them on boot so they register on the singleton.

import { createServer } from "http"
import { parse } from "url"
import { readdirSync } from "fs"
import { pathToFileURL } from "url"
import path from "path"
import next from "next"
import { config as loadDotenv } from "dotenv"
import { attachMogobaseWebSocket } from "mogobase/server"

const cwd = process.cwd()
loadDotenv({ path: [path.join(cwd, ".env"), path.join(cwd, ".env.local")] })

const dev = process.env.NODE_ENV !== "production"
const hostname = process.env.HOST || "localhost"
const port = Number(process.env.PORT) || 3000

async function loadHandlers() {
  const dir = path.join(cwd, "mogobase")
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    console.warn(`[mogobase] No ./mogobase/ folder at ${dir}; skipping handler registration`)
    return
  }
  for (const file of entries) {
    if (!file.endsWith(".ts") && !file.endsWith(".js")) continue
    const full = path.join(dir, file)
    await import(pathToFileURL(full).href)
  }
}

async function main() {
  await loadHandlers()

  const app = next({ dev, hostname, port })
  const handle = app.getRequestHandler()
  await app.prepare()

  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true))
  })

  attachMogobaseWebSocket(server, "/ws")

  server.listen(port, () => {
    console.log(`> Mogobase + Next.js ready on http://${hostname}:${port}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
