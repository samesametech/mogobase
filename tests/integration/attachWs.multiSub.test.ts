// Many live subscriptions on one attachWs socket, over a real MongoDB (4.0.0): one socket per
// browser tab instead of one per live query.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { attachMogobaseWebSocket } from "@/server/attachWs"
import { query, v } from "@/server/handlers"

const MODEL = "multi_sub_rows"
let server: http.Server
let wss: ReturnType<typeof attachMogobaseWebSocket>
let port: number
let refuseOrg = ""

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(MODEL)
  query("multiSub.rows", {
    args: v.object({ org: v.string() }),
    handler: async ({ org }, ctx) => {
      ctx.watch(MODEL, { org })
      if (org === refuseOrg) throw new Error("Forbidden")
      return (await ctx.db.model(MODEL).find({ org }).toArray()).map((r: any) => r._id).sort()
    },
  })
  server = http.createServer()
  wss = attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 20 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await wss.stop()
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  refuseOrg = ""
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [MODEL])
  await client.close()
})

const insert = (_id: string, org: string) => DB.model(MODEL).insertOne({ _id: _id as any, org, createdAt: 0, updatedAt: 0, deletedAt: null })
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))
const results = (client: any, sid: unknown) => client.inbox.filter((m: any) => m.type === "QueryResult" && m.sid === sid)

describe("attachWs: many subscriptions on one socket", () => {
  it("two subscriptions, one socket: each updates on its own writes, with its sid", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", sid: "A", name: "multiSub.rows", args: { org: "a" } })
    client.send({ type: "query", sid: "B", name: "multiSub.rows", args: { org: "b" } })
    await client.waitFor((m) => m.sid === "A")
    await client.waitFor((m) => m.sid === "B")
    await settle()
    await insert("a1", "a")
    await client.waitFor((m) => m.sid === "A" && m.data?.includes("a1"))
    await settle()
    expect(results(client, "B")).toHaveLength(1) // B's filter did not match: no re-run
    await client.close()
  })

  it("the same filter twice: unsubscribing one keeps the other live (one hub stream, two subscribers)", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", sid: "A", name: "multiSub.rows", args: { org: "s" } })
    client.send({ type: "query", sid: "B", name: "multiSub.rows", args: { org: "s" } })
    await client.waitFor((m) => m.sid === "A")
    await client.waitFor((m) => m.sid === "B")
    await settle()
    client.send({ type: "unsubscribe", sid: "A" })
    await client.waitFor((m) => m.type === "Unsubscribed" && m.sid === "A")
    await insert("s1", "s")
    await client.waitFor((m) => m.sid === "B" && m.data?.includes("s1"))
    await settle()
    expect(results(client, "A")).toHaveLength(1) // nothing after the unsubscribe
    await client.close()
  })

  it("a sibling whose re-run is refused ends alone; the default subscription (no sid) lives beside them", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "multiSub.rows", args: { org: "d" } })
    client.send({ type: "query", sid: "X", name: "multiSub.rows", args: { org: "x" } })
    client.send({ type: "query", sid: "Y", name: "multiSub.rows", args: { org: "y" } })
    await client.waitFor((m) => m.type === "QueryResult" && m.sid === undefined)
    await client.waitFor((m) => m.sid === "X")
    await client.waitFor((m) => m.sid === "Y")
    await settle()
    refuseOrg = "x"
    await insert("x1", "x")
    await client.waitFor((m) => m.sid === "X" && m.success === false)
    await insert("y1", "y")
    await insert("d1", "d")
    await client.waitFor((m) => m.sid === "Y" && m.data?.includes("y1"))
    await client.waitFor((m) => m.type === "QueryResult" && m.sid === undefined && m.data?.includes("d1"))
    await client.close()
  })
})
