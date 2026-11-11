// The legacy `mogobase dev` transport (hono.ts + ws.ts) runs queries on the same live-query
// engine as attachWs, so it gets the same guarantees: watches re-registered on every run,
// a paginated subscription that answers and re-runs. Every watch here is its own change
// stream (no shared hub on this path).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { AddressInfo } from "net"
import { serve } from "@hono/node-server"
import MongoPagingUpstream from "mongo-cursor-pagination"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import app from "@/server/hono"
import ws from "@/server/ws"
import { mutationRefusedFrame } from "@/server/messages"

const MEMBERS = "legacy_members"
const POSTS = "legacy_posts"
const HOMED = "legacy_homed" // lives in HOME only
const HOME = "mogobase_test_legacy_home"
const SYNCED = "legacy_synced"
const SYNCED_MORE = ["legacy_synced_b", "legacy_synced_c"]
let server: ReturnType<typeof serve>
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(MEMBERS)
  defineModel(POSTS)
  defineModel(HOMED, undefined, { databases: [HOME] })
  defineModel(SYNCED, undefined, { sync: true, clientFields: ["userId"] })
  for (const m of SYNCED_MORE) defineModel(m, undefined, { sync: true })

  query("legacyNamed", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(POSTS, undefined, { dbName: HOME })
      return await ctx.useDatabase(HOME).model(POSTS).find({}).toArray()
    },
  })

  query("legacyHomed", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(HOMED)
      return await ctx.useDatabase(HOME).model(HOMED).find({}).toArray()
    },
  })

  query("legacyTeamPosts", {
    args: v.object({ team: v.string() }),
    handler: async (args, ctx) => {
      ctx.watch(MEMBERS, { team: args.team })
      const ids = (await ctx.db.model(MEMBERS).find({ team: args.team }).toArray()).map((m: any) => m.userId)
      ctx.watch(POSTS, { authorId: { $in: ids } })
      return await ctx.db.model(POSTS).find({ authorId: { $in: ids } }).sort({ _id: 1 }).toArray()
    },
  })

  query("legacyPostsPaged", {
    args: v.object({ paginationOpts: v.any().optional() }),
    handler: async (args, ctx) => {
      ctx.watch(POSTS)
      return await (MongoPagingUpstream as any).find(ctx.db.model(POSTS), { ...(args.paginationOpts || {}) })
    },
  })

  server = serve({ fetch: app.fetch, port: 0 })
  ws.injectWebSocket(server)
  await new Promise<void>((res) => (server.listening ? res() : server.once("listening", () => res())))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [MEMBERS, POSTS])
  await client.close()
  await DB.model(MEMBERS).insertOne({ _id: "m-u1" as any, team: "t1", userId: "u1" })
})

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

describe("legacy ws.ts transport", () => {
  it("re-registers a watch built from data the handler read", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "legacyTeamPosts", args: { team: "t1" } })
    await client.waitFor((m) => m.type === "QueryResult" && m.success)
    await settle()

    await DB.model(MEMBERS).insertOne({ _id: "m-u2" as any, team: "t1", userId: "u2" })
    await settle()
    await DB.model(POSTS).insertOne({ _id: "p1" as any, authorId: "u2" })
    const update = await client.waitFor((m) => m.type === "QueryResult" && m.data?.length === 1)
    expect(update.data[0]._id).toBe("p1")
    await client.close()
  })

  it("answers a paginated query and re-runs it on a change", async () => {
    await DB.model(POSTS).insertMany([{ _id: "a" as any }, { _id: "b" as any }])
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "paginated-query", name: "legacyPostsPaged", args: { paginationOpts: { limit: 5 } } })
    const first = await client.waitFor((m) => m.type === "PaginatedQueryResult" && m.success)
    expect(first.data.results).toHaveLength(2)
    await settle()

    await DB.model(POSTS).insertOne({ _id: "c" as any })
    const update = await client.waitFor((m) => m.type === "PaginatedQueryResult" && m.data?.results?.length === 3)
    expect(update.success).toBe(true)
    await client.close()
  })
})

describe("legacy ws.ts singleton", () => {
  it("another `new` hands back the same instance, with the same engine, built once", () => {
    const Ctor = (ws as any).constructor
    const engine = (ws as any)._live
    const again = new Ctor()
    expect(again).toBe(ws)
    expect((again as any)._live).toBe(engine)
  })
})

describe("legacy ws.ts: headers as attachWs passes them (review round 15)", () => {
  // ws.ts handed the resolver and the sync policy the Fetch Headers object, attachWs a plain
  // object: a resolver written for one read nothing on the other (headers["x-tenant"] was
  // undefined on a Headers), so every request silently read the default database.
  it("a resolver reading headers[\"x-tenant\"] — and one calling headers.get — both see the header", async () => {
    query("legacyHeaderShape", { args: v.object({}), handler: async (_args, ctx) => (ctx.db as any).db.databaseName })
    for (const resolver of [
      ({ headers }: any) => headers?.["x-tenant"] ?? null,
      ({ headers }: any) => headers?.get?.("x-tenant") ?? null,
    ]) {
      DB.setRequestResolver(resolver)
      try {
        const client = createWsClient(`ws://localhost:${port}/ws`, { "x-tenant": "legacy_header_tenant" })
        await client.open()
        client.send({ type: "query", name: "legacyHeaderShape", args: {} })
        expect((await client.waitFor((m) => m.type === "QueryResult")).data).toBe("legacy_header_tenant")
        await client.close()
      } finally {
        DB.setRequestResolver(null)
      }
    }
  })
})

describe("legacy ws.ts: the request's database", () => {
  it("a query reads, and watches, the database the resolver picks — as on attachWs", async () => {
    query("legacyTenantRows", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        ctx.watch("legacy_tenant_rows")
        return await ctx.db.model("legacy_tenant_rows").find({}).toArray()
      },
    })
    DB.setRequestResolver(({ headers }) => (typeof headers?.get === "function" ? headers.get("x-tenant") : headers?.["x-tenant"]) ?? null)
    try {
      await DB.useDatabase("legacy_tenant").db.collection("legacy_tenant_rows").deleteMany({})
      const client = createWsClient(`ws://localhost:${port}/ws`, { "x-tenant": "legacy_tenant" })
      await client.open()
      client.send({ type: "query", name: "legacyTenantRows", args: {} })
      expect((await client.waitFor((m) => m.type === "QueryResult" && m.success)).data).toEqual([])
      await new Promise((r) => setTimeout(r, 400))
      await DB.useDatabase("legacy_tenant").db.collection("legacy_tenant_rows").insertOne({ _id: "t1" as any })
      await client.waitFor((m) => m.type === "QueryResult" && m.data?.[0]?._id === "t1")
      await client.close()
    } finally {
      DB.setRequestResolver(null)
    }
  })
})

describe("legacy ws.ts transport: a model with one declared home (review round 3)", () => {
  it("is watched in its home, not in the request's database", async () => {
    const { db, client: raw } = await connectTestMongo(HOME)
    await cleanCollections(db, [HOMED])
    await raw.close()
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "legacyHomed", args: {} })
    await client.waitFor((m) => m.type === "QueryResult" && m.success)
    await settle()
    await DB.useDatabase(HOME).model(HOMED).insertOne({ _id: "h1" as any, name: "a" })
    const update = await client.waitFor((m) => m.type === "QueryResult" && m.data?.length === 1)
    expect(update.data[0]._id).toBe("h1")
    await client.close()
  })
})

describe("legacy ws.ts transport: the same frames as attachWs (review round 3)", () => {
  it("refuses a mutation with the shared frame, rid echoed", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "mutation", name: "anything", args: {}, rid: "r9" })
    const frame = await client.waitFor((m) => m.type === "MutationResult")
    expect(frame).toEqual(mutationRefusedFrame({ rid: "r9" }))
    expect(frame.rid).toBe("r9")
    await client.close()
  })

  it("a failed sync pull names the error by its message", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-pull", model: POSTS, checkpoint: null })
    const frame = await client.waitFor((m) => m.type === "SyncPullResult")
    expect(frame.success).toBe(false)
    expect(frame.error).toMatch(/^Model "legacy_posts" is not configured for sync/)
    await client.close()
  })
})

describe("legacy ws.ts transport: a watch that names its database (review round 4)", () => {
  it("listens there", async () => {
    const { db, client: raw } = await connectTestMongo(HOME)
    await cleanCollections(db, [POSTS])
    await raw.close()
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "legacyNamed", args: {} })
    await client.waitFor((m) => m.type === "QueryResult" && m.success)
    await settle()
    await DB.useDatabase(HOME).model(POSTS).insertOne({ _id: "n1" as any, authorId: "x" })
    const update = await client.waitFor((m) => m.type === "QueryResult" && m.data?.length === 1)
    expect(update.data[0]._id).toBe("n1")
    await client.close()
  })
})

describe("legacy ws.ts transport: answers what attachWs answers (review round 5)", () => {
  it("an unknown message type gets an error frame, rid echoed", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "qeury", name: "x", rid: "u1" })
    const frame = await client.waitFor((m) => m.rid === "u1")
    expect(frame).toEqual({ success: false, error: "Unknown type: qeury", rid: "u1" })
    await client.close()
  })

  it("a message that is not JSON gets an error frame, and the socket stays usable", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.ws.send("{not json")
    expect(await client.waitFor((m) => m.error === "Invalid JSON")).toEqual({ success: false, error: "Invalid JSON" })
    client.send({ type: "qeury", name: "x", rid: "after" })
    await client.waitFor((m) => m.rid === "after")
    await client.close()
  })
})

describe("legacy ws.ts transport: the sync policy's filter narrows sync-stream (review round 6)", () => {
  it("a write by another tenant sends nothing; one in the caller's filter does", async () => {
    ws.setSyncPolicy(() => ({ allow: true, filter: { userId: "alice" } }))
    try {
      const { db, client: raw } = await connectTestMongo("mogobase_test_integration")
      await cleanCollections(db, [SYNCED])
      await raw.close()
      const client = createWsClient(`ws://localhost:${port}/ws`)
      await client.open()
      client.send({ type: "sync-subscribe", models: [SYNCED] })
      await settle(600)
      const stamps = { createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null }
      await DB.model(SYNCED).insertOne({ _id: "bob-1" as any, userId: "bob", ...stamps })
      await settle()
      expect(client.inbox.filter((m) => m.type === "sync-stream")).toHaveLength(0)
      await DB.model(SYNCED).insertOne({ _id: "alice-1" as any, userId: "alice", ...stamps })
      await client.waitFor((m) => m.type === "sync-stream" && m.model === SYNCED, 3000)
      await client.close()
    } finally {
      ws.setSyncPolicy(undefined)
    }
  })
})

describe("legacy ws.ts transport: sync-subscribe asks the policy for every model at once (review round 8)", () => {
  it("does not wait for one policy call before starting the next", async () => {
    const starts: number[] = []
    ws.setSyncPolicy(async () => {
      starts.push(Date.now())
      await new Promise((r) => setTimeout(r, 150))
      return { allow: true }
    })
    try {
      const client = createWsClient(`ws://localhost:${port}/ws`)
      await client.open()
      client.send({ type: "sync-subscribe", models: [SYNCED, ...SYNCED_MORE] })
      await vi.waitFor(() => expect(starts).toHaveLength(3), { timeout: 2000 })
      expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(100)
      await client.close()
    } finally {
      ws.setSyncPolicy(undefined)
    }
  })
})

describe("legacy ws.ts: many subscriptions on one socket (4.0.0)", () => {
  it("answers each sid with its own frames, and acks an unsubscribe", async () => {
    query("legacySid", { args: v.object({ n: v.number() }), handler: async ({ n }) => n * 10 })
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", sid: "one", name: "legacySid", args: { n: 1 } })
    client.send({ type: "query", sid: "two", name: "legacySid", args: { n: 2 } })
    expect((await client.waitFor((m) => m.type === "QueryResult" && m.sid === "one")).data).toBe(10)
    expect((await client.waitFor((m) => m.type === "QueryResult" && m.sid === "two")).data).toBe(20)
    client.send({ type: "unsubscribe", sid: "one" })
    await client.waitFor((m) => m.type === "Unsubscribed" && m.sid === "one")
    await client.close()
  })
})
