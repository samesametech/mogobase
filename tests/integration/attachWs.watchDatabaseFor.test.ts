// A collection that lives in ONE database must be watched there, whatever the request resolved.
//
// 3.7.0 made every change stream follow the database the query READ — right for tenant data,
// and exactly wrong for a collection the app keeps in one place (identity, reference tables):
// the handler pins its read to the main database, the stream opens on the tenant's empty copy,
// and the subscription answers correctly once and never re-runs. `watchDatabaseFor` is the
// app's way of saying where such a collection lives; this drives real sockets against a real
// replica set and was confirmed to FAIL without it on the "wakes for MAIN" cases below.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { connectTestMongo, getTestMongoUri, cleanCollections } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const MAIN = "mogobase_test_watchfor_main"
const TENANT = "mogobase_test_watchfor_tenant"
const SHARED = "settings_shared" // lives in MAIN only
const OWN = "orders_watchfor" // per-tenant

let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = MAIN
  await DB.connect()
  defineModel(SHARED, undefined, { clientFields: ["key"] })
  defineModel(OWN, undefined, { clientFields: ["userId"] })
  DB.setRequestResolver(({ headers }: any) => (headers?.["x-tenant"] ? TENANT : null))

  // Both handlers read the SHARED table off MAIN explicitly — the pinned-read half an app
  // already has to do. Only the watch half is under test here.
  query("listShared", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(SHARED) // bare → streamHub path
      return await DB.useDatabase(MAIN).model(SHARED).find({}).toArray()
    },
  })
  query("listSharedPipeline", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(SHARED, [{ $match: {} }, { $project: { fullDocument: 1 } }]) // non-$match → per-socket stream
      return await DB.useDatabase(MAIN).model(SHARED).find({}).toArray()
    },
  })
  query("listOwn", {
    args: v.object({ userId: v.string() }),
    handler: async (args, ctx) => {
      ctx.watch(OWN, { userId: args.userId })
      return await ctx.db.model(OWN).find({ userId: args.userId }).toArray()
    },
  })

  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", {
    refetchDebounceMs: 100,
    watchDatabaseFor: (model) => (model === SHARED ? MAIN : null),
  })
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
    await cleanCollections(db, [SHARED, OWN])
    await client.close()
  }
})

const stamps = () => ({ createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null })
const results = (c: { inbox: any[] }) => c.inbox.filter((m) => m.type === "QueryResult")
const settle = () => new Promise((r) => setTimeout(r, 500))

async function subscribed(name: string, args: any = {}) {
  const tenant = createWsClient(`ws://localhost:${port}/ws`, { "x-tenant": "yes" })
  await tenant.open()
  tenant.send({ type: "query", name, args })
  await tenant.waitFor((m) => m.type === "QueryResult")
  await settle() // change stream attach
  return tenant
}

describe("attachWs: watchDatabaseFor watches a shared collection where it lives", () => {
  for (const name of ["listShared", "listSharedPipeline"]) {
    it(`${name}: a tenant socket wakes for a write to MAIN`, async () => {
      const tenant = await subscribed(name)
      const before = results(tenant).length

      // Without the option this stream is on TENANT's empty copy and nothing ever arrives.
      await DB.useDatabase(MAIN).model(SHARED).insertOne({ _id: "s1" as any, key: "a", ...stamps() })
      await settle()

      expect(results(tenant).length).toBeGreaterThan(before)
      expect(results(tenant).at(-1).data.map((d: any) => d._id)).toEqual(["s1"])
      await tenant.close()
    })
  }

  it("does NOT wake for a write to the tenant's copy of the shared collection", async () => {
    const tenant = await subscribed("listShared")
    const before = results(tenant).length

    await DB.useDatabase(TENANT).model(SHARED).insertOne({ _id: "t1" as any, key: "a", ...stamps() })
    await settle()

    expect(results(tenant).length).toBe(before)
    await tenant.close()
  })

  it("a model the option does not name still watches the database it read", async () => {
    const tenant = await subscribed("listOwn", { userId: "u1" })
    const before = results(tenant).length

    await DB.useDatabase(TENANT).model(OWN).insertOne({ _id: "o1" as any, userId: "u1", ...stamps() })
    await settle()

    expect(results(tenant).length).toBeGreaterThan(before)
    expect(results(tenant).at(-1).data.map((d: any) => d._id)).toEqual(["o1"])
    await tenant.close()
  })
})
