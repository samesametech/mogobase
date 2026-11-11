// sync-subscribe on attachWs: which database its stream watches, what a throwing resolver does
// to it, and two of them in quick succession.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { type ChangeStream, Collection } from "mongodb"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const MODEL = "sync_subscribe_probe"
let policyFilter: any = { userId: "u1" }
let policyDelayMs = 0
const policyCalls: number[] = []
const PLAIN = "sync_subscribe_not_synced" // never declared for sync
const EXTRA = ["sync_subscribe_extra_a", "sync_subscribe_extra_b"]
let server: http.Server
let port: number
const streams: ChangeStream[] = []
const openStreams = () => streams.filter((cs) => !cs.closed).length

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(MODEL, undefined, { sync: true, clientFields: ["text", "userId"] })
  defineModel(PLAIN)
  for (const m of EXTRA) defineModel(m, undefined, { sync: true })
  const realWatch = Collection.prototype.watch
  vi.spyOn(Collection.prototype, "watch").mockImplementation(function (this: Collection, ...a: any[]) {
    const cs = (realWatch as any).apply(this, a)
    if (this.collectionName === MODEL) streams.push(cs)
    return cs
  })
  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", {
    syncPolicy: async () => {
      policyCalls.push(Date.now())
      if (policyDelayMs) await new Promise((r) => setTimeout(r, policyDelayMs))
      return { allow: true, filter: policyFilter }
    },
  })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [MODEL, PLAIN])
  await client.close()
  await vi.waitFor(() => expect(openStreams()).toBe(0))
})

afterEach(() => {
  DB.setRequestResolver(null)
  policyFilter = { userId: "u1" }
  policyDelayMs = 0
  policyCalls.length = 0
})

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const pushed = (id: string) =>
  DB.model(MODEL).insertOne({ _id: id as any, text: "x", userId: "u1", createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null })

describe("attachWs sync-subscribe (review round 5)", () => {
  it("watches the database sync pulls and pushes, not the one the request resolves to", async () => {
    DB.setRequestResolver(() => "mogobase_test_some_tenant")
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-subscribe", models: [MODEL] })
    await settle()
    await pushed("a") // where pushChanges writes: the default database
    await client.waitFor((m) => m.type === "sync-stream" && m.model === MODEL, 3000)
    await client.close()
  })

  it("a resolver that throws neither breaks sync-subscribe nor leaves a rejection unhandled", async () => {
    DB.setRequestResolver(() => {
      throw new Error("no session")
    })
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-subscribe", models: [MODEL] })
    await settle()
    await pushed("b")
    await client.waitFor((m) => m.type === "sync-stream", 3000)
    await client.close()
  })

  it("two sync-subscribes in quick succession leave nothing behind once the socket closes", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-subscribe", models: [MODEL] })
    client.send({ type: "sync-subscribe", models: [MODEL] })
    await settle()
    expect(openStreams()).toBe(1)
    await client.close()
    await vi.waitFor(() => expect(openStreams()).toBe(0), { timeout: 3000 })
  })
})

describe("attachWs sync-subscribe: a policy filter the hub cannot run (review round 6)", () => {
  it("streams on a change stream of its own, filtered by MongoDB", async () => {
    policyFilter = { tags: { $elemMatch: { $eq: "mine" } } }
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-subscribe", models: [MODEL] })
    await settle()
    const stamps = { createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null }
    await DB.model(MODEL).insertOne({ _id: "other" as any, tags: ["theirs"], ...stamps })
    await settle()
    expect(client.inbox.filter((m) => m.type === "sync-stream")).toHaveLength(0)
    await DB.model(MODEL).insertOne({ _id: "mine" as any, tags: ["mine"], ...stamps })
    await client.waitFor((m) => m.type === "sync-stream", 3000)
    await client.close()
  })
})

describe("attachWs sync-subscribe (review round 7)", () => {
  it("a model not declared for sync never streams, whatever the policy says", async () => {
    policyFilter = undefined
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    client.send({ type: "sync-subscribe", models: [PLAIN] })
    await settle()
    await DB.model(PLAIN).insertOne({ _id: "p1" as any, x: 1 })
    await settle()
    warn.mockRestore()
    expect(client.inbox.filter((m) => m.type === "sync-stream")).toHaveLength(0)
    await client.close()
  })

  it("subscribes every model at once, not one policy and stream start after another", async () => {
    policyDelayMs = 150
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-subscribe", models: [MODEL, ...EXTRA] })
    await vi.waitFor(() => expect(policyCalls).toHaveLength(3), { timeout: 2000 })
    expect(Math.max(...policyCalls) - Math.min(...policyCalls)).toBeLessThan(100)
    await client.close()
  })

  it("a sync stream of its own that ends is reopened, and the client told to pull", async () => {
    policyFilter = { tags: { $elemMatch: { $eq: "mine" } } }
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    client.send({ type: "sync-subscribe", models: [MODEL] })
    await settle()
    await DB.db.collection(MODEL).insertOne({ _id: "seed" as any, tags: ["x"] })
    await DB.db.dropCollection(MODEL) // invalidates the stream: it ends on its own
    await settle(1800) // reopened after 1 s
    const before = client.inbox.filter((m) => m.type === "sync-stream").length
    const stamps = { createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null }
    await DB.model(MODEL).insertOne({ _id: "after" as any, tags: ["mine"], ...stamps })
    await vi.waitFor(() => expect(client.inbox.filter((m) => m.type === "sync-stream").length).toBeGreaterThan(before), { timeout: 3000 })
    warn.mockRestore()
    await client.close()
  })
})

describe("attachWs sync-subscribe: hard deletes (review round 10)", () => {
  it("another tenant's hard delete does not reach this tenant's sync stream", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-subscribe", models: [MODEL] }) // the policy: userId u1
    await settle()
    await DB.db.collection(MODEL).insertOne({ _id: "theirs" as any, userId: "u2" }) // raw, not stamped
    await DB.db.collection(MODEL).deleteOne({ _id: "theirs" as any }) // the hard-delete escape hatch
    await settle()
    expect(client.inbox.filter((m) => m.type === "sync-stream")).toHaveLength(0)
    await client.close()
  })
})

describe("attachWs sync-subscribe: a policy filter with \$expr (review round 14)", () => {
  // The policy filter is a document filter — pull applies it to the rows. On the stream its
  // `$expr` field paths ("$userId") were read off the change event, where no such field is:
  // nothing ever matched, and clients heard of no write until they reconnected.
  it("streams the changes the same filter pulls", async () => {
    policyFilter = { $expr: { $eq: ["$userId", "u1"] } }
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-subscribe", models: [MODEL] })
    await settle()
    const stamps = { createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null }
    await DB.model(MODEL).insertOne({ _id: "theirs" as any, userId: "u2", text: "x", ...stamps })
    await settle()
    expect(client.inbox.filter((m) => m.type === "sync-stream")).toHaveLength(0)
    await pushed("expr-mine")
    await client.waitFor((m) => m.type === "sync-stream", 3000)
    await client.close()
  })
})

describe("attachWs sync-subscribe: a policy filter with \$jsonSchema (review round F14)", () => {
  // Every top-level operator but $and/$or/$nor/$not/$expr passed through unprefixed: a
  // $jsonSchema was checked against the change event, which never satisfies a document's schema,
  // so clients were never told to pull. It now applies to the event's fullDocument.
  it("streams the changes the same filter pulls", async () => {
    policyFilter = { $jsonSchema: { required: ["userId"], properties: { userId: { enum: ["u1"] } } } }
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-subscribe", models: [MODEL] })
    await settle()
    const stamps = { createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null }
    await DB.model(MODEL).insertOne({ _id: "theirs-schema" as any, userId: "u2", text: "x", ...stamps })
    await settle()
    expect(client.inbox.filter((m) => m.type === "sync-stream")).toHaveLength(0)
    await pushed("schema-mine")
    await client.waitFor((m) => m.type === "sync-stream", 3000)
    await client.close()
  })
})
