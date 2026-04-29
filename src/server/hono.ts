import { Context, Hono } from "hono"
import { cors } from "hono/cors"
import ws from "@/server/ws"
import handlers from "@/server/handlers"
import DB from "@/db"
import path from "path"
import { config } from "dotenv"
import { pullChanges, pushChanges, type SyncPolicy } from "@/server/sync"

let syncPolicy: SyncPolicy | undefined

export function setHonoSyncPolicy(policy: SyncPolicy | undefined) {
  syncPolicy = policy
  ws.setSyncPolicy(policy)
}

const cwd = process.cwd()

config({ path: [path.join(cwd, ".env"), path.join(cwd, ".env.local")] })

const app = new Hono()

ws.createNodeWebSocket(app)

app.get("/", (c: Context) => {
  return c.json({
    apiVersion: "1.0.0",
  })
})

console.log("HOST", process.env.NEXT_PUBLIC_HOST || process.env.HOST)
app.get("/ws", ws.upgradeWebSocket())
app.use(
  "/api/handlers",
  cors({
    origin: process.env.NEXT_PUBLIC_HOST || process.env.HOST || "http://localhost:3000",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "GET", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  })
)
app.get("/api/handlers", async (c: Context) => {
  const body = c.req.query()
  const { name, args } = body
  if (!name) {
    return c.text("Name is required", 400)
  }
  try {
    await DB.connect()
    const rs = await handlers._runQuery(name, JSON.parse(args), {
      db: DB,
      headers: c.req.raw.headers || null,
    })
    // await DB.disconnect();
    return c.json(rs)
  } catch (error) {
    return c.text(`${error}`, 400)
  }
})

app.post("/api/handlers", async (c: Context) => {
  const body = await c.req.json()
  const { name, args } = body
  if (!name) {
    return c.text("Name is required", 400)
  }
  try {
    await DB.connect()
    const rs = await handlers._runMutation(name, args, {
      db: DB,
      headers: c.req.raw.headers || null,
    })
    // await DB.disconnect();
    return c.json(rs)
  } catch (error) {
    return c.text(`${error}`, 400)
  }
})

app.use(
  "/api/sync",
  cors({
    origin: process.env.NEXT_PUBLIC_HOST || process.env.HOST || "http://localhost:3000",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  })
)

app.post("/api/sync", async (c: Context) => {
  const action = c.req.query("action")
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.text("Invalid JSON", 400)
  }
  const headers = c.req.raw.headers
  try {
    if (action === "pull") {
      let extraFilter: Record<string, any> | undefined
      if (syncPolicy) {
        const decision = await syncPolicy({ op: "pull", model: body.model, headers })
        if (!decision.allow) return c.text("Forbidden", 403)
        extraFilter = decision.filter
      }
      const rs = await pullChanges({
        model: body.model,
        checkpoint: body.checkpoint ?? null,
        batchSize: body.batchSize,
        extraFilter,
      })
      return c.json(rs)
    }
    if (action === "push") {
      let transform
      if (syncPolicy) {
        const decision = await syncPolicy({ op: "push", model: body.model, headers })
        if (!decision.allow) return c.text("Forbidden", 403)
        transform = decision.transform
      }
      const rs = await pushChanges({
        model: body.model,
        rows: body.rows || [],
        transform,
      })
      return c.json(rs)
    }
    return c.text("Unknown action", 400)
  } catch (error) {
    return c.text(`${error}`, 400)
  }
})

export default app
