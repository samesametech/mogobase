// A live re-run of a paginated query keeps every row the client has loaded.
//
// The re-run used to read Math.max(loadedCount, limit) rows in ONE call, and
// mongo-cursor-pagination clamps any limit to MAX_LIMIT = 300: a client scrolled past 300
// rows had its list cut back to 300 on the next write to a watched collection, and its
// scroll position jumped. It now reads the window in pages of at most 300.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import MongoPagingUpstream from "mongo-cursor-pagination"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const MODEL = "rows_paged_window"
const TOTAL = 350
let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(MODEL)

  query("pagedWindowRows", {
    args: v.object({ paginationOpts: v.any().optional() }),
    handler: async (args, ctx) => {
      ctx.watch(MODEL)
      return await (MongoPagingUpstream as any).find(ctx.db.model(MODEL), { ...(args.paginationOpts || {}) })
    },
  })

  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 50 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [MODEL])
  await client.close()
  const ids = Array.from({ length: TOTAL }, (_, i) => `r${String(i).padStart(4, "0")}`)
  await DB.model(MODEL).insertMany(ids.map((_id) => ({ _id: _id as any, n: 0 })))
})

describe("attachWs: a paginated re-run past 300 loaded rows", () => {
  it("re-reads all 350 loaded rows, in order, when a watched row changes", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "paginated-query", name: "pagedWindowRows", args: { paginationOpts: { limit: 100, sortAscending: true } } })
    await client.waitFor((m) => m.type === "PaginatedQueryResult" && m.success)

    const loaded: string[] = client.inbox.find((m) => m.type === "PaginatedQueryResult").data.results.map((r: any) => r._id)
    for (let page = 1; page <= 3; page++) {
      client.send({ type: "paginated-query-load-next" })
      await client.waitFor((m) => m.type === "PaginatedQueryPage" && client.inbox.filter((x) => x.type === "PaginatedQueryPage").length === page)
      loaded.push(...client.inbox.filter((m) => m.type === "PaginatedQueryPage")[page - 1].data.results.map((r: any) => r._id))
    }
    expect(loaded).toHaveLength(TOTAL)

    await new Promise((r) => setTimeout(r, 300))
    await DB.model(MODEL).updateOne({ _id: "r0010" as any }, { $set: { n: 1 } })
    const rerun = await client.waitFor((m) => m.type === "PaginatedQueryResult" && client.inbox.filter((x) => x.type === "PaginatedQueryResult").length === 2)

    expect(rerun.success).toBe(true)
    expect(rerun.data.results.map((r: any) => r._id)).toEqual(loaded)
    expect(rerun.data.results.find((r: any) => r._id === "r0010").n).toBe(1)
    expect(rerun.data.hasNext).toBe(false)
    expect(rerun.data.hasPrevious).toBe(false)
    await client.close()
  })
})

describe("attachWs: a paginated query that names no sort", () => {
  // The first page goes to the handler with the client's paginationOpts as sent, so the pager's
  // own default (descending) ordered it — while loads and re-runs added sortAscending: true,
  // and the next page walked the other way from the cursor.
  it("keeps the first page's order through a load and a re-run", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "paginated-query", name: "pagedWindowRows", args: { paginationOpts: { limit: 3 } } })
    const first = await client.waitFor((m) => m.type === "PaginatedQueryResult" && m.success)
    expect(first.data.results.map((r: any) => r._id)).toEqual(["r0349", "r0348", "r0347"])

    client.send({ type: "paginated-query-load-next" })
    const page = await client.waitFor((m) => m.type === "PaginatedQueryPage")
    expect(page.data.results.map((r: any) => r._id)).toEqual(["r0346", "r0345", "r0344"])

    await new Promise((r) => setTimeout(r, 300))
    await DB.model(MODEL).updateOne({ _id: "r0348" as any }, { $set: { n: 1 } })
    const rerun = await client.waitFor((m) => m.type === "PaginatedQueryResult" && client.inbox.filter((x) => x.type === "PaginatedQueryResult").length === 2)
    expect(rerun.data.results.map((r: any) => r._id)).toEqual(["r0349", "r0348", "r0347", "r0346", "r0345", "r0344"])
    await client.close()
  })
})

describe("attachWs: a first page the pager clamped", () => {
  it("a client asking for 1000 rows got 300, and a re-run keeps it at 300 — it does not grow to 1000", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "paginated-query", name: "pagedWindowRows", args: { paginationOpts: { limit: 1000, sortAscending: true } } })
    const first = await client.waitFor((m) => m.type === "PaginatedQueryResult" && m.success)
    expect(first.data.results).toHaveLength(300)
    expect(first.data.hasNext).toBe(true)

    await new Promise((r) => setTimeout(r, 300))
    await DB.model(MODEL).updateOne({ _id: "r0010" as any }, { $set: { n: 1 } })
    const rerun = await client.waitFor((m) => m.type === "PaginatedQueryResult" && client.inbox.filter((x) => x.type === "PaginatedQueryResult").length === 2)
    expect(rerun.data.results).toHaveLength(300)
    expect(rerun.data.hasNext).toBe(true)
    await client.close()
  })
})
