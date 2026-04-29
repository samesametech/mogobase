import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { connectTestMongo, getTestMongoUri, cleanCollections } from "../helpers/mongo"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { streamChanges } from "@/server/sync"

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel("events_stream", undefined, { sync: true })
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, ["events_stream"])
  await client.close()
})

describe("streamChanges", () => {
  it("fires onEvent on insert", async () => {
    const events: string[] = []
    const unsub = streamChanges(["events_stream"], (m) => events.push(m))
    // Give the change stream time to attach
    await new Promise((r) => setTimeout(r, 500))
    await DB.model("events_stream").insertOne({
      _id: "1" as any, type: "x", createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
    })
    await new Promise((r) => setTimeout(r, 500))
    unsub()
    expect(events).toContain("events_stream")
  })

  it("multiple subscribers fan out from one underlying stream", async () => {
    const a: string[] = []
    const b: string[] = []
    const u1 = streamChanges(["events_stream"], (m) => a.push(m))
    const u2 = streamChanges(["events_stream"], (m) => b.push(m))
    await new Promise((r) => setTimeout(r, 500))
    await DB.model("events_stream").insertOne({
      _id: "2" as any, type: "y", createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null,
    })
    await new Promise((r) => setTimeout(r, 500))
    u1()
    u2()
    expect(a).toContain("events_stream")
    expect(b).toContain("events_stream")
  })
})
