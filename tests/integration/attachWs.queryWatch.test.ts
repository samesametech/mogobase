import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { connectTestMongo, getTestMongoUri, cleanCollections } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel("orders_qwatch", undefined, { sync: true, clientFields: ["userId", "total"] })

  query("listMyOrders", {
    args: v.object({ userId: v.string() }),
    handler: async (args, ctx) => {
      ctx.watch("orders_qwatch", { userId: args.userId })
      return await ctx.db.model("orders_qwatch").find({ userId: args.userId }).toArray()
    },
  })

  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 100 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, ["orders_qwatch"])
  await client.close()
})

describe("attachWs: useQuery with shared streamHub + debounce + backpressure", () => {
  it("subscribes once, receives initial result, then a coalesced update on burst write", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "listMyOrders", args: { userId: "u1" } })
    const initial = await client.waitFor((m) => m.type === "QueryResult")
    expect(initial.success).toBe(true)
    expect(initial.data).toEqual([])

    // Burst write: 30 inserts within 50ms — far below the 100ms debounce window.
    await new Promise((r) => setTimeout(r, 500)) // change stream attach
    const startCount = client.inbox.filter((m) => m.type === "QueryResult").length
    for (let i = 0; i < 30; i++) {
      await DB.model("orders_qwatch").insertOne({
        _id: `o${i}` as any, userId: "u1", total: i,
        createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
      })
    }
    // Wait one debounce window + buffer
    await new Promise((r) => setTimeout(r, 400))
    const endCount = client.inbox.filter((m) => m.type === "QueryResult").length
    const newRefetches = endCount - startCount
    // We expect exactly 1 refetch from the burst. Allow up to 2 because real
    // timers + change stream batching can split a burst across debounce windows.
    expect(newRefetches).toBeGreaterThanOrEqual(1)
    expect(newRefetches).toBeLessThanOrEqual(2)
    const last = client.inbox.filter((m) => m.type === "QueryResult").at(-1)
    expect(last.data).toHaveLength(30)
    await client.close()
  })

  it("does not notify subscribers whose filter doesn't match", async () => {
    const a = createWsClient(`ws://localhost:${port}/ws`)
    const b = createWsClient(`ws://localhost:${port}/ws`)
    await a.open(); await b.open()
    a.send({ type: "query", name: "listMyOrders", args: { userId: "alice" } })
    b.send({ type: "query", name: "listMyOrders", args: { userId: "bob" } })
    await a.waitFor((m) => m.type === "QueryResult")
    await b.waitFor((m) => m.type === "QueryResult")
    await new Promise((r) => setTimeout(r, 500))

    const aBefore = a.inbox.filter((m) => m.type === "QueryResult").length
    const bBefore = b.inbox.filter((m) => m.type === "QueryResult").length

    await DB.model("orders_qwatch").insertOne({
      _id: "alice-1" as any, userId: "alice", total: 1,
      createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
    })
    await new Promise((r) => setTimeout(r, 400))

    const aAfter = a.inbox.filter((m) => m.type === "QueryResult").length
    const bAfter = b.inbox.filter((m) => m.type === "QueryResult").length
    expect(aAfter).toBeGreaterThan(aBefore)
    expect(bAfter).toBe(bBefore)
    await a.close(); await b.close()
  })
})
