// A watch whose stream dies on its own is reopened, and the live query keeps updating.
//
// A change stream that ended without being closed by mogobase — a non-resumable error, a
// hub that could not reconnect — stayed registered as an open watch, so every later
// reconcile skipped it. The query answered, and never updated again.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { type ChangeStream, Collection } from "mongodb"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const OWN = "dead_watch_own"
const SHARED = "dead_watch_shared"
let server: http.Server
let port: number
const streams: Record<string, ChangeStream[]> = { [OWN]: [], [SHARED]: [] }
let failNextSharedOpen = false

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(OWN)
  defineModel(SHARED)

  const realWatch = Collection.prototype.watch
  vi.spyOn(Collection.prototype, "watch").mockImplementation(function (this: Collection, ...a: any[]) {
    if (this.collectionName === SHARED && failNextSharedOpen) {
      failNextSharedOpen = false
      throw new Error("cannot open a change stream right now")
    }
    const cs = (realWatch as any).apply(this, a)
    if (streams[this.collectionName]) streams[this.collectionName].push(cs)
    return cs
  })

  query("deadWatchOwn", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(OWN, [{ $match: { operationType: { $in: ["insert", "update"] } } }, { $project: { operationType: 1 } }])
      return await ctx.db.model(OWN).find({}).toArray()
    },
  })
  query("deadWatchShared", {
    args: v.object({}),
    handler: async (_args, ctx) => {
      ctx.watch(SHARED)
      return await ctx.db.model(SHARED).find({}).toArray()
    },
  })

  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 50 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [OWN, SHARED])
  await client.close()
})

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

async function subscribe(name: string) {
  const client = createWsClient(`ws://localhost:${port}/ws`)
  await client.open()
  client.send({ type: "query", name, args: {} })
  await client.waitFor((m) => m.type === "QueryResult" && m.success)
  await settle()
  return client
}

describe("attachWs: a watch that dies is reopened", () => {
  it("its own change stream, closed from outside, is reopened", async () => {
    const client = await subscribe("deadWatchOwn")
    const before = streams[OWN].length
    await streams[OWN][before - 1].close() // not mogobase closing it
    await vi.waitFor(() => expect(streams[OWN].length).toBe(before + 1))
    await settle()

    await DB.model(OWN).insertOne({ _id: "after-death" as any })
    await client.waitFor((m) => m.type === "QueryResult" && m.data?.some((d: any) => d._id === "after-death"))
    await client.close()
  })

  it("a shared hub stream that fails and cannot reconnect is reopened by the subscription", async () => {
    const client = await subscribe("deadWatchShared")
    const failing = streams[SHARED][streams[SHARED].length - 1]
    failNextSharedOpen = true // the hub's reconnect fails…
    failing.emit("error", new Error("non-resumable"))
    // …so the hub reports the subscription dead, and the engine re-runs and re-subscribes.
    await vi.waitFor(() => expect(streams[SHARED].filter((cs) => !cs.closed).length).toBe(1), { timeout: 5000 })
    await settle()

    await DB.model(SHARED).insertOne({ _id: "after-reconnect" as any })
    await client.waitFor((m) => m.type === "QueryResult" && m.data?.some((d: any) => d._id === "after-reconnect"))
    await client.close()
  })
})

describe("attachWs: a filter the hub cannot evaluate", () => {
  it("gets a change stream of its own, and the query stays live", async () => {
    query("deadWatchExpr", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        ctx.watch(OWN, { $match: { $expr: { $gt: ["$fullDocument.n", 5] } } })
        return await ctx.db.model(OWN).find({ n: { $gt: 5 } }).toArray()
      },
    })
    const client = await subscribe("deadWatchExpr")
    await DB.model(OWN).insertOne({ _id: "small" as any, n: 1 })
    await settle()
    expect(client.inbox.filter((m) => m.type === "QueryResult")).toHaveLength(1)
    await DB.model(OWN).insertOne({ _id: "big" as any, n: 10 })
    await client.waitFor((m) => m.type === "QueryResult" && m.data?.some((d: any) => d._id === "big"))
    await client.close()
  })
})

describe("attachWs: what a watch's own change stream is opened with", () => {
  it("the driver options the handler gave, fullDocument — and nothing of mogobase's, nor a pre-image", async () => {
    const seen: any[] = []
    const realWatch = (Collection.prototype.watch as any).getMockImplementation?.()
    const spy = vi.spyOn(Collection.prototype, "watch").mockImplementation(function (this: Collection, ...a: any[]) {
      if (this.collectionName === OWN) seen.push(a[1])
      return realWatch.apply(this, a)
    })
    query("deadWatchOptions", {
      args: v.object({}),
      handler: async (_args, ctx) => {
        ctx.watch(OWN, [{ $match: {} }, { $project: { operationType: 1 } }], {
          paginatedField: "createdAt",
          sortAscending: true,
          ignoreFields: ["x"],
          batchSize: 7,
        } as any)
        return []
      },
    })
    try {
      const client = await subscribe("deadWatchOptions")
      expect(seen.at(-1)).toEqual({ batchSize: 7, fullDocument: "updateLookup" })
      await client.close()
    } finally {
      spy.mockImplementation(realWatch)
    }
  })
})
