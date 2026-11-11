// A handler's ctx.headers over attachWs (review round 17): Node's headers, as before, plus the
// Fetch methods — ctx.headers.get(name) threw "get is not a function" here while it worked over
// HTTP (a Fetch Headers) and ws.ts, so an auth helper written once broke on live queries.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { attachMogobaseWebSocket } from "@/server/attachWs"
import { query, v } from "@/server/handlers"

let server: http.Server
let wss: ReturnType<typeof attachMogobaseWebSocket>
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  query("r17.whoAsks", {
    args: v.object({}),
    handler: async (_args, ctx: any) => ({ byGet: ctx.headers.get("x-user"), byKey: ctx.headers["x-user"], keys: Object.keys(ctx.headers).includes("get") }),
  })
  server = http.createServer()
  wss = attachMogobaseWebSocket(server)
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await wss.stop()
  await new Promise<void>((res) => server.close(() => res()))
})

describe("attachWs: a handler's ctx.headers", () => {
  it("reads a header by key and by get(), and the methods are not keys", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`, { "X-User": "u17" })
    await client.open()
    client.send({ type: "query", name: "r17.whoAsks", args: {} })
    expect((await client.waitFor((m) => m.type === "QueryResult")).data).toEqual({ byGet: "u17", byKey: "u17", keys: false })
    await client.close()
  })
})
