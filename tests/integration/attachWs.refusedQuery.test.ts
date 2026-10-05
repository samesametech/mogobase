import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { type ChangeStream, Collection } from "mongodb"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import MongoPagingUpstream from "mongo-cursor-pagination"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

// Apps call ctx.watch() BEFORE their auth gate. Watches registered inline therefore outlived a
// refused run: the caller stayed subscribed to another tenant's collection and got a fresh
// "Forbidden" frame per write there — a cross-tenant write-activity oracle. A member revoked
// mid-subscription kept getting them too. Fixed in 3.11.0: watches register only after the
// handler succeeds, and any failed run tears the subscription down.
const MODEL = "ledger_refused"
let server: http.Server
let port: number
let revoked = false

// Every change stream opened on MODEL, so a test can tell whether a subscription is still held.
const streams: ChangeStream[] = []
const openStreams = () => streams.filter((cs) => !cs.closed).length

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(MODEL, undefined, { clientFields: ["org", "amount"] })

  const realWatch = Collection.prototype.watch
  vi.spyOn(Collection.prototype, "watch").mockImplementation(function (this: Collection, ...a: any[]) {
    const cs = (realWatch as any).apply(this, a)
    if (this.collectionName === MODEL) streams.push(cs)
    return cs
  })

  query("refusedQueryLedger", {
    args: v.object({ org: v.string() }),
    handler: async (args, ctx) => {
      // Watched twice before the gate, as real handlers do: also pins one stream per hub slot.
      ctx.watch(MODEL, { org: args.org })
      ctx.watch(MODEL, { org: args.org })
      if (args.org !== "mine" || revoked) throw new Error("Forbidden")
      return await ctx.db.model(MODEL).find({ org: args.org }).toArray()
    },
  })

  query("refusedQueryLedgerPaged", {
    args: v.object({ org: v.string(), paginationOpts: v.any().optional() }),
    handler: async (args, ctx) => {
      ctx.watch(MODEL, { org: args.org })
      if (revoked) throw new Error("Forbidden")
      return await (MongoPagingUpstream as any).find(ctx.db.model(MODEL), {
        query: { org: args.org },
        limit: args.paginationOpts?.limit ?? 10,
      })
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
  revoked = false
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [MODEL])
  await client.close()
  await vi.waitFor(() => expect(openStreams()).toBe(0))
})

const insert = (org: string) =>
  DB.model(MODEL).insertOne({
    _id: `${org}-${Math.random()}` as any,
    org,
    amount: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
  })
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms))
const results = (client: ReturnType<typeof createWsClient>) => client.inbox.filter((m) => m.type === "QueryResult")

describe("attachWs: a refused query keeps no watch", () => {
  it("a refused first run holds no subscription, and a write to the watched rows sends nothing", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "refusedQueryLedger", args: { org: "victim" } })
    const first = await client.waitFor((m) => m.type === "QueryResult")
    expect(first.success).toBe(false)

    await settle()
    expect(openStreams()).toBe(0) // socket still open, yet nothing is watching for it
    await insert("victim")
    await settle()
    expect(results(client)).toHaveLength(1)
    await client.close()
  })

  it("a legitimate subscription receives live updates over one shared stream", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "refusedQueryLedger", args: { org: "mine" } })
    expect((await client.waitFor((m) => m.type === "QueryResult")).data).toEqual([])

    await settle()
    expect(openStreams()).toBe(1)
    await insert("mine")
    const update = await client.waitFor((m) => m.type === "QueryResult" && m.data?.length === 1)
    expect(update.success).toBe(true)
    await client.close()
    await vi.waitFor(() => expect(openStreams()).toBe(0))
  })

  it("a re-run refused after revocation tears the subscription down", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "refusedQueryLedger", args: { org: "mine" } })
    await client.waitFor((m) => m.type === "QueryResult" && m.success)
    await settle()

    revoked = true
    await insert("mine")
    await client.waitFor((m) => m.type === "QueryResult" && !m.success)
    await vi.waitFor(() => expect(openStreams()).toBe(0))

    const framesAfterRefusal = results(client).length
    await insert("mine")
    await settle()
    expect(results(client)).toHaveLength(framesAfterRefusal)
    await client.close()
  })

  it("a paginated re-run refused after revocation tears the subscription down", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "paginated-query", name: "refusedQueryLedgerPaged", args: { org: "mine" } })
    await client.waitFor((m) => m.type === "PaginatedQueryResult" && m.success)
    await settle()
    expect(openStreams()).toBe(1)

    revoked = true
    await insert("mine")
    await client.waitFor((m) => m.type === "PaginatedQueryResult" && !m.success)
    await vi.waitFor(() => expect(openStreams()).toBe(0))
    await client.close()
  })
})
