import { Context, Hono } from "hono"
import { cors } from "hono/cors"
import ws from "@/server/ws"
import handlers from "@/server/handlers"
import DB from "@/db"

const app = new Hono()

ws.createNodeWebSocket(app)

app.get("/", (c: Context) => {
  return c.json({
    apiVersion: "1.0.0",
  })
})

app.get("/ws", ws.upgradeWebSocket())
app.use("/api/*", cors())
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
    })
    // await DB.disconnect();
    return c.json(rs)
  } catch (error) {
    return c.text(`${error}`, 400)
  }
})

export default app
