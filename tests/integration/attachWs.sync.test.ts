import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { connectTestMongo, getTestMongoUri, cleanCollections } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { attachMogobaseWebSocket } from "@/server/attachWs"

let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel("messages_syncws", undefined, { sync: true, clientFields: ["text", "userId"] })

  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", {
    syncPolicy: () => ({ allow: true, filter: { userId: "u1" } }),
  })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, ["messages_syncws"])
  await client.close()
})

describe("attachWs: sync subscribe + pull + push", () => {
  it("sync-subscribe receives sync-stream on matching insert, ignores non-matching", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-subscribe", models: ["messages_syncws"] })
    await new Promise((r) => setTimeout(r, 500))

    const before = client.inbox.filter((m) => m.type === "sync-stream").length

    await DB.model("messages_syncws").insertOne({
      _id: "a" as any, text: "hello", userId: "u1",
      createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
    })
    await new Promise((r) => setTimeout(r, 300))
    const afterMatch = client.inbox.filter((m) => m.type === "sync-stream").length
    expect(afterMatch).toBeGreaterThan(before)

    await DB.model("messages_syncws").insertOne({
      _id: "b" as any, text: "ignore", userId: "u2",
      createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
    })
    await new Promise((r) => setTimeout(r, 300))
    const afterNoMatch = client.inbox.filter((m) => m.type === "sync-stream").length
    expect(afterNoMatch).toBe(afterMatch) // no extra

    await client.close()
  })

  it("sync-pull returns docs filtered by policy", async () => {
    await DB.model("messages_syncws").insertMany([
      { _id: "a" as any, text: "mine", userId: "u1", createdAt: 1, updatedAt: 1, deletedAt: null },
      { _id: "b" as any, text: "theirs", userId: "u2", createdAt: 1, updatedAt: 2, deletedAt: null },
    ])
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "sync-pull", model: "messages_syncws", checkpoint: null })
    const r = await client.waitFor((m) => m.type === "SyncPullResult")
    expect(r.documents.map((d: any) => d._id)).toEqual(["a"])
    await client.close()
  })

  it("sync-push round-trips and conflicts surface", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({
      type: "sync-push",
      model: "messages_syncws",
      rows: [{ newDocumentState: { _id: "p1", text: "pushed", userId: "u1" } }],
    })
    const r = await client.waitFor((m) => m.type === "SyncPushResult")
    expect(r.conflicts).toEqual([])
    const stored = await DB.model("messages_syncws").findOne({ _id: "p1" as any }) as any
    expect(stored.text).toBe("pushed")
    await client.close()
  })
})
