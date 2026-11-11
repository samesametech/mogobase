// A watch counts as open only once its change stream runs on the server. collection.watch()
// returns before the $changeStream aggregate is answered, and the server starts the stream
// when it runs: a write made in between was missed, which is exactly the gap a catch-up run
// re-reads to close. Against a real replica set: a write made the moment the open resolves
// is always seen, and the open does not wait out its timeout to get there.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import DB from "@/db"
import { openChangeStreamWatch, STREAM_START_TIMEOUT_MS, streamStarted } from "@/server/changeStreamWatch"
import { createStreamHub } from "@/server/streamHub"
import { routeWatchInput } from "@/server/watchInput"

const MODEL = "stream_start_probe"

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await db.collection(MODEL).deleteMany({})
  await client.close()
})

afterAll(async () => {
  await DB.model(MODEL).deleteMany({})
})

describe("a change stream is started before its watch counts as open", () => {
  it("openChangeStreamWatch: a write right after the open is seen, every time", async () => {
    for (let i = 0; i < 5; i++) {
      const onEvent = vi.fn()
      const started = Date.now()
      const w = await openChangeStreamWatch({
        collection: DB.model(MODEL),
        model: MODEL,
        pipeline: [],
        options: {},
        onEvent,
        label: "test",
      })
      expect(Date.now() - started).toBeLessThan(STREAM_START_TIMEOUT_MS / 2)
      await DB.db.collection(MODEL).insertOne({ i })
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalled(), { timeout: 3000 })
      await w.close()
    }
  })

  it("the hub: a write right after subscribe resolves is seen, every time", async () => {
    const hub = createStreamHub({
      whenReady: (stream) => streamStarted(stream as any),
      openStream: async (dbName, model) => DB.useDatabase(dbName).model(model).watch([], { fullDocument: "updateLookup" }) as any,
    })
    for (let i = 0; i < 5; i++) {
      const cb = vi.fn()
      const unsubscribe = await hub.subscribe(DB.db.databaseName, MODEL, undefined, cb)
      await DB.db.collection(MODEL).insertOne({ hub: i })
      await vi.waitFor(() => expect(cb).toHaveBeenCalled(), { timeout: 3000 })
      await unsubscribe()
    }
    await hub.shutdown()
  })
})

describe("a stream of its own for a filter with a top-level $not (review round 8)", () => {
  it("opens, and filters as the JS matcher would", async () => {
    const route: any = routeWatchInput({ $not: { kind: "noise" }, tags: { $elemMatch: { $eq: "mine" } } })
    expect(route.kind).toBe("pipeline")
    const onEvent = vi.fn()
    const onDead = vi.fn()
    const w = await openChangeStreamWatch({
      collection: DB.model(MODEL),
      model: MODEL,
      pipeline: route.pipeline,
      options: { fullDocument: "updateLookup" },
      onEvent,
      onDead,
      label: "test",
    })
    await DB.db.collection(MODEL).insertOne({ kind: "noise", tags: ["mine"] }) // excluded by the $not
    await DB.db.collection(MODEL).insertOne({ kind: "real", tags: ["theirs"] }) // no tag match
    await DB.db.collection(MODEL).insertOne({ kind: "real", tags: ["mine"] })
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled(), { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 300))
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onDead).not.toHaveBeenCalled() // MongoDB accepted the $match
    await w.close()
  })
})

describe("a bare filter with a top-level $expr (review round 9)", () => {
  it("filters on the document, through a stream of its own", async () => {
    const route: any = routeWatchInput({ kind: "expr", $expr: { $gt: ["$fullDocument.n", 5] } })
    expect(route.kind).toBe("pipeline")
    const onEvent = vi.fn()
    const w = await openChangeStreamWatch({
      collection: DB.model(MODEL),
      model: MODEL,
      pipeline: route.pipeline,
      options: { fullDocument: "updateLookup" },
      onEvent,
      label: "test",
    })
    await DB.db.collection(MODEL).insertOne({ kind: "expr", n: 3 })
    await DB.db.collection(MODEL).insertOne({ kind: "other", n: 10 })
    await DB.db.collection(MODEL).insertOne({ kind: "expr", n: 10 })
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled(), { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 300))
    expect(onEvent).toHaveBeenCalledTimes(1)
    await w.close()
  })
})
