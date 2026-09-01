// A watched query must WATCH the database it READ.
//
// With a per-request resolver (DB.setRequestResolver) the handler binds to the caller's
// database, but the change streams behind ctx.watch used to be opened on the DEFAULT one.
// The result is the quietest possible failure: the first answer is correct, and then the
// socket never hears about its own database again. Nothing throws, nothing logs, and a
// screen that has silently stopped updating is indistinguishable from a slow network.
//
// This also covers the streamHub, whose slots are keyed by (database, model): keyed by model
// alone, the second socket attaches to the first one's stream and is told about writes to a
// database it is not looking at.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { connectTestMongo, getTestMongoUri, cleanCollections } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const MAIN = "mogobase_test_resolver_main"
const TENANT = "mogobase_test_resolver_tenant"
const MODEL = "orders_resolver"

let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = MAIN
  await DB.connect()
  defineModel(MODEL, undefined, { clientFields: ["userId", "total"] })

  // The tenant's database comes from a handshake header — the shape a real deployment uses,
  // since a browser cannot set headers on anything but the WS handshake.
  DB.setRequestResolver(({ headers }: any) => (headers?.["x-tenant"] ? TENANT : null))

  query("listOrders", {
    args: v.object({ userId: v.string() }),
    handler: async (args, ctx) => {
      ctx.watch(MODEL, { userId: args.userId })
      return await ctx.db.model(MODEL).find({ userId: args.userId }).toArray()
    },
  })

  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 100 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  DB.setRequestResolver(null)
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  for (const name of [MAIN, TENANT]) {
    const { db, client } = await connectTestMongo(name)
    await cleanCollections(db, [MODEL])
    await client.close()
  }
})

const row = (id: string, userId: string) => ({
  _id: id as any,
  userId,
  total: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  deletedAt: null,
})

const results = (c: { inbox: any[] }) => c.inbox.filter((m) => m.type === "QueryResult")

describe("attachWs: a watched query watches the database it read", () => {
  it("reads the resolved database, not the default", async () => {
    await DB.useDatabase(TENANT).model(MODEL).insertOne(row("t1", "u1"))
    await DB.model(MODEL).insertOne(row("m1", "u1"))

    const tenant = createWsClient(`ws://localhost:${port}/ws`, { "x-tenant": "yes" })
    await tenant.open()
    tenant.send({ type: "query", name: "listOrders", args: { userId: "u1" } })
    const first = await tenant.waitFor((m) => m.type === "QueryResult")
    expect(first.success).toBe(true)
    expect(first.data.map((d: any) => d._id)).toEqual(["t1"])
    await tenant.close()
  })

  it("refetches on a write to its OWN database", async () => {
    const tenant = createWsClient(`ws://localhost:${port}/ws`, { "x-tenant": "yes" })
    await tenant.open()
    tenant.send({ type: "query", name: "listOrders", args: { userId: "u1" } })
    await tenant.waitFor((m) => m.type === "QueryResult")
    await new Promise((r) => setTimeout(r, 500)) // change stream attach

    const before = results(tenant).length
    await DB.useDatabase(TENANT).model(MODEL).insertOne(row("t2", "u1"))
    await new Promise((r) => setTimeout(r, 500))

    // Before the fix this watched MAIN, so this insert produced nothing at all and the
    // socket sat on a stale answer forever.
    expect(results(tenant).length).toBeGreaterThan(before)
    expect(results(tenant).at(-1).data.map((d: any) => d._id)).toEqual(["t2"])
    await tenant.close()
  })

  it("does NOT refetch on a write to a database it is not reading", async () => {
    const tenant = createWsClient(`ws://localhost:${port}/ws`, { "x-tenant": "yes" })
    const main = createWsClient(`ws://localhost:${port}/ws`)
    await tenant.open()
    await main.open()
    tenant.send({ type: "query", name: "listOrders", args: { userId: "u1" } })
    main.send({ type: "query", name: "listOrders", args: { userId: "u1" } })
    await tenant.waitFor((m) => m.type === "QueryResult")
    await main.waitFor((m) => m.type === "QueryResult")
    await new Promise((r) => setTimeout(r, 500))

    const tenantBefore = results(tenant).length
    const mainBefore = results(main).length

    // Writing to MAIN must wake the main socket and leave the tenant's alone. Two sockets
    // on the same model is exactly the case a model-only streamHub key gets wrong.
    await DB.model(MODEL).insertOne(row("m2", "u1"))
    await new Promise((r) => setTimeout(r, 500))

    expect(results(main).length).toBeGreaterThan(mainBefore)
    expect(results(tenant).length).toBe(tenantBefore)
    await tenant.close()
    await main.close()
  })
})
