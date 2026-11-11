// Backpressure on attachWs: while a socket's send buffer is over maxBufferedBytes, its
// change-triggered re-runs are held; one runs when it drains.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { WebSocket } from "ws"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const MODEL = "backpressure_rows"
let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(MODEL)
  query("backpressureRows", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(MODEL)
      return await ctx.db.model(MODEL).countDocuments({})
    },
  })
  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 20, maxBufferedBytes: 1000 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [MODEL])
  await client.close()
})

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const results = (c: { inbox: any[] }) => c.inbox.filter((m) => m.type === "QueryResult")

describe("attachWs: backpressure (scalability review)", () => {
  it("a socket whose buffer is over maxBufferedBytes gets no re-runs until it drains, then one", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "backpressureRows", args: {} })
    await client.waitFor((m) => m.type === "QueryResult")
    await settle()

    let buffered = 5000 // every socket reports a full buffer (the client's own is never asked)
    const getter = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockImplementation(() => buffered)
    for (let i = 0; i < 3; i++) await DB.model(MODEL).insertOne({ i })
    await settle()
    expect(results(client)).toHaveLength(1)

    buffered = 0
    const update = await client.waitFor((m) => m.type === "QueryResult" && m.data === 3, 2000)
    getter.mockRestore()
    expect(update.success).toBe(true)
    await settle()
    expect(results(client)).toHaveLength(2)
    await client.close()
  })
})
