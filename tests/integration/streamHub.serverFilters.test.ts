// The saving from filtering the shared change stream in MongoDB (attachWs
// `serverSideWatchFilters`), measured against a real MongoDB, and the guarantees that
// come with it: a subscriber that joins later loses nothing, and live queries still work.
//
// Default mode: ONE unfiltered stream per (database, model), every change sent to this
// process with its full document, every subscriber's filter matched in JS. Server mode: the
// stream's $match is the OR of the live subscribers' filters.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"
import { createStreamHub, type HubStreamSpec } from "@/server/streamHub"
import { bareFilterToChangeEventMatch } from "@/server/watchInput"

const DBNAME = "mogobase_test_integration"
const MODEL = "hub_measure"
const LIVE_MODEL = "hub_server_live"
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms))

// A hub opened the way attachWs opens it, counting every change event MongoDB sends it.
function measuredHub(serverSideFilters: boolean) {
  const received = { events: 0, opens: 0, specs: [] as (HubStreamSpec | undefined)[] }
  const hub = createStreamHub({
    serverSideFilters,
    reopenDelayMs: 20,
    openStream: async (dbName, model, spec) => {
      received.opens++
      received.specs.push(spec)
      const collection = DB.useDatabase(dbName).model(model)
      const cs: any = spec
        ? collection.watch(spec.pipeline, {
            ...(spec.fullDocument ? { fullDocument: "updateLookup" } : {}),
            ...(spec.startAfter !== undefined ? { startAfter: spec.startAfter as any } : {}),
          })
        : collection.watch([], { fullDocument: "updateLookup" })
      cs.on("change", () => received.events++)
      return cs
    },
  })
  return { hub, received }
}

let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = DBNAME
  await DB.connect()
  defineModel(LIVE_MODEL)
  query("hubServerLive", {
    args: v.object({ org: v.string() }),
    handler: async (args, ctx) => {
      ctx.watch(LIVE_MODEL, { org: args.org })
      return await ctx.db.model(LIVE_MODEL).find({ org: args.org }).toArray()
    },
  })
  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 50, serverSideWatchFilters: true })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo(DBNAME)
  await cleanCollections(db, [MODEL, LIVE_MODEL])
  await client.close()
  const rows = [{ _id: "a1", org: "a", n: 0 }, ...Array.from({ length: 50 }, (_, i) => ({ _id: `b${i}`, org: "b", n: 0 }))]
  await DB.model(MODEL).insertMany(rows as any[])
})

describe("server-side watch filters: what reaches this process", () => {
  it("50 writes to an org nobody here watches, 1 to the watched one: 51 events in default mode, 1 in server mode", async () => {
    const plain = measuredHub(false)
    const filtered = measuredHub(true)
    const onPlain = vi.fn()
    const onFiltered = vi.fn()
    const watchOrgA = bareFilterToChangeEventMatch({ org: "a" })
    const offPlain = await plain.hub.subscribe(DBNAME, MODEL, watchOrgA, onPlain)
    const offFiltered = await filtered.hub.subscribe(DBNAME, MODEL, watchOrgA, onFiltered)
    await settle()

    for (let i = 0; i < 50; i++) await DB.model(MODEL).updateOne({ _id: `b${i}` as any }, { $set: { n: 1 } })
    await DB.model(MODEL).updateOne({ _id: "a1" as any }, { $set: { n: 1 } })
    await vi.waitFor(() => expect(onPlain).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(onFiltered).toHaveBeenCalledTimes(1))
    await settle(300)

    // Both subscribers saw exactly the one change they watch; the default stream carried all 51.
    expect(plain.received.events).toBe(51)
    expect(filtered.received.events).toBe(1)
    expect(onFiltered).toHaveBeenCalledWith(expect.objectContaining({ _id: "a1", n: 1 }), "update")
    await offPlain()
    await offFiltered()
  })

  it("a subscriber that joins later misses nothing written right after it joined", async () => {
    const filtered = measuredHub(true)
    const offA = await filtered.hub.subscribe(DBNAME, MODEL, bareFilterToChangeEventMatch({ org: "a" }), vi.fn())
    await settle()
    // Make the stream advance, so it has a resume point.
    await DB.model(MODEL).updateOne({ _id: "a1" as any }, { $set: { n: 2 } })
    await settle(300)

    const onB = vi.fn()
    const offB = await filtered.hub.subscribe(DBNAME, MODEL, bareFilterToChangeEventMatch({ org: "b" }), onB)
    // Written before the stream has reopened to include org b.
    await DB.model(MODEL).updateOne({ _id: "b7" as any }, { $set: { n: 3 } })
    await vi.waitFor(() => expect(onB).toHaveBeenCalledWith(expect.objectContaining({ _id: "b7", n: 3 }), "update"))
    expect(filtered.received.opens).toBe(2)
    expect(filtered.received.specs[1]?.startAfter).toBeDefined()
    await offA()
    await offB()
  })

  it("a stream whose subscribers do not filter on the document is opened without the lookup", async () => {
    const filtered = measuredHub(true)
    const off = await filtered.hub.subscribe(DBNAME, MODEL, { operationType: "delete" }, vi.fn())
    expect(filtered.received.specs[0]).toEqual({ pipeline: [{ $match: { operationType: "delete" } }], fullDocument: false })
    await off()
  })
})

describe("attachWs with serverSideWatchFilters", () => {
  it("a live query wakes for its own org's write, not another's", async () => {
    await DB.model(LIVE_MODEL).insertMany([{ _id: "x" as any, org: "a" }, { _id: "y" as any, org: "b" }])
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "hubServerLive", args: { org: "a" } })
    await client.waitFor((m) => m.type === "QueryResult" && m.success)
    await settle()

    await DB.model(LIVE_MODEL).updateOne({ _id: "y" as any }, { $set: { n: 1 } })
    await settle(300)
    expect(client.inbox.filter((m) => m.type === "QueryResult")).toHaveLength(1)

    await DB.model(LIVE_MODEL).updateOne({ _id: "x" as any }, { $set: { n: 1 } })
    const update = await client.waitFor((m) => m.type === "QueryResult" && m.data?.[0]?.n === 1)
    expect(update.success).toBe(true)
    await client.close()
  })
})
