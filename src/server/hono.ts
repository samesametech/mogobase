import { Context, Hono } from "hono"
import { cors } from "hono/cors"
import ws from "@/server/ws"
import handlers from "@/server/handlers"
import DB from "@/db"
import path from "path"
import { config } from "dotenv"

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

export default app
