import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import MongoPagingUpstream from "mongo-cursor-pagination"
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
  defineModel("notes_paged", undefined, { sync: true, clientFields: ["title"] })

  query("listNotes", {
    args: v.object({ paginationOpts: v.any().optional() }),
    handler: async (args, ctx) => {
      ctx.watch("notes_paged")
      return await (MongoPagingUpstream as any).find(ctx.db.model("notes_paged"), {
        ...(args.paginationOpts || {}),
        limit: args.paginationOpts?.limit ?? 10,
      })
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
  await cleanCollections(db, ["notes_paged"])
  await client.close()
})

describe("attachWs: paginated query", () => {
  it("returns initial page + coalesced refresh on mutation", async () => {
    for (let i = 0; i < 5; i++) {
      await DB.model("notes_paged").insertOne({
        _id: `n${i}` as any, title: `t${i}`,
        createdAt: Date.now() + i, updatedAt: Date.now() + i, deletedAt: null,
      })
    }

    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "paginated-query", name: "listNotes", args: { paginationOpts: { limit: 3 } } })
    const first = await client.waitFor((m) => m.type === "PaginatedQueryResult")
    expect(first.success).toBe(true)
    expect(first.data.results).toHaveLength(3)

    await new Promise((r) => setTimeout(r, 500))
    const before = client.inbox.filter((m) => m.type === "PaginatedQueryResult").length

    // Burst-update existing rows
    for (let i = 0; i < 5; i++) {
      await DB.model("notes_paged").updateOne(
        { _id: `n${i}` as any },
        { $set: { title: `t${i}-v2`, updatedAt: Date.now() + 1000 + i } }
      )
    }
    await new Promise((r) => setTimeout(r, 400))
    const after = client.inbox.filter((m) => m.type === "PaginatedQueryResult").length
    expect(after - before).toBeGreaterThanOrEqual(1)
    expect(after - before).toBeLessThanOrEqual(2)

    await client.close()
  })
})
