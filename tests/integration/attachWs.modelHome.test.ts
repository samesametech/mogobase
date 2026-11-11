// A model whose `databases` option names ONE home is watched there, whatever the request
// resolved to — without the app repeating the rule in watchDatabaseFor. Before, the watch
// followed the request's database: a tenant socket listened to the tenant's empty copy of an
// identity-only collection, so the query answered once and never updated.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const MAIN = "mogobase_test_home_main"
const TENANT = "mogobase_test_home_tenant"
const IDENTITY = "mogobase_test_home_identity"
const HOMED = "home_members" // lives in IDENTITY only
const RULED = "home_ruled" // no databases option: only the handler knows it reads IDENTITY
let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = MAIN
  await DB.connect()
  defineModel(HOMED, undefined, { databases: [IDENTITY] })
  DB.setRequestResolver(({ headers }: any) => (headers?.["x-tenant"] ? TENANT : null))

  query("homedMembers", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(HOMED) // the hub
      return await ctx.useDatabase(IDENTITY).model(HOMED).find({}).toArray()
    },
  })
  query("homedMembersPipeline", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(HOMED, [{ $match: {} }, { $project: { fullDocument: 1 } }]) // a stream of its own
      return await ctx.useDatabase(IDENTITY).model(HOMED).find({}).toArray()
    },
  })

  query("ruledMembers", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(RULED, undefined, { dbName: IDENTITY }) // says where, as the read does
      return await ctx.useDatabase(IDENTITY).model(RULED).find({}).toArray()
    },
  })

  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 50 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  DB.setRequestResolver(null)
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  for (const name of [IDENTITY, TENANT]) {
    const { db, client } = await connectTestMongo(name)
    await cleanCollections(db, [HOMED, RULED])
    await client.close()
  }
})

const settle = () => new Promise((r) => setTimeout(r, 500))
const results = (c: { inbox: any[] }) => c.inbox.filter((m) => m.type === "QueryResult")

describe("attachWs: a model with one declared home is watched there", () => {
  for (const name of ["homedMembers", "homedMembersPipeline"]) {
    it(`${name}: a tenant socket wakes for a write to the model's home`, async () => {
      const tenant = createWsClient(`ws://localhost:${port}/ws`, { "x-tenant": "yes" })
      await tenant.open()
      tenant.send({ type: "query", name, args: {} })
      await tenant.waitFor((m) => m.type === "QueryResult")
      await settle()

      await DB.useDatabase(IDENTITY).model(HOMED).insertOne({ _id: "m1" as any, name: "a" })
      const update = await tenant.waitFor((m) => m.type === "QueryResult" && m.data?.length === 1)
      expect(update.data[0]._id).toBe("m1")

      // The tenant's copy is not where the model lives: a write there wakes nobody.
      const before = results(tenant).length
      await DB.useDatabase(TENANT).model(HOMED).insertOne({ _id: "t1" as any, name: "b" })
      await settle()
      expect(results(tenant)).toHaveLength(before)
      await tenant.close()
    })
  }
})

describe("attachWs: a watch that names its database (review round 4)", () => {
  it("listens there, whatever the request resolved to", async () => {
    const tenant = createWsClient(`ws://localhost:${port}/ws`, { "x-tenant": "yes" })
    await tenant.open()
    tenant.send({ type: "query", name: "ruledMembers", args: {} })
    await tenant.waitFor((m) => m.type === "QueryResult")
    await settle()
    await DB.useDatabase(IDENTITY).model(RULED).insertOne({ _id: "r1" as any, name: "a" })
    const update = await tenant.waitFor((m) => m.type === "QueryResult" && m.data?.length === 1)
    expect(update.data[0]._id).toBe("r1")
    await tenant.close()
  })
})
