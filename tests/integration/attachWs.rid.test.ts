// The request id, end to end over attachWs: echoed on the answer, on the re-runs after it,
// on a transport-level refusal — and absent for a client that never sends one.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const MODEL = "rid_rows"
let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(MODEL)
  query("ridRows", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(MODEL)
      return await ctx.db.model(MODEL).find({}).toArray()
    },
  })
  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 50 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [MODEL])
  await client.close()
})

const results = (client: ReturnType<typeof createWsClient>) => client.inbox.filter((m) => m.type === "QueryResult")

describe("attachWs: rid", () => {
  it("rides the answer, the re-runs, a re-ask's answer, and a refusal", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "ridRows", args: {}, rid: "q1" })
    expect((await client.waitFor((m) => m.type === "QueryResult")).rid).toBe("q1")
    await new Promise((r) => setTimeout(r, 300))

    await DB.model(MODEL).insertOne({ _id: "x" as any })
    expect((await client.waitFor((m) => m.type === "QueryResult" && m.data?.length === 1)).rid).toBe("q1")

    client.send({ type: "query", name: "ridRows", args: {}, rid: "q2" })
    await client.waitFor((m) => m.type === "QueryResult" && m.rid === "q2")

    client.send({ type: "mutation", name: "anything", args: {}, rid: "m1" })
    expect((await client.waitFor((m) => m.type === "MutationResult")).rid).toBe("m1")
    await client.close()
  })

  it("a client that sends no rid sees frames without one", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "ridRows", args: {} })
    await client.waitFor((m) => m.type === "QueryResult")
    await new Promise((r) => setTimeout(r, 300))
    await DB.model(MODEL).insertOne({ _id: "y" as any })
    await client.waitFor((m) => m.type === "QueryResult" && m.data?.length === 1)
    expect(results(client).every((m) => !("rid" in m))).toBe(true)
    await client.close()
  })
})
