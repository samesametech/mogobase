// ctx.watch(model, filter, { ignoreFields }): an update that changed only those fields does
// not re-run the query.
//
// A cron stamping `reconciledAt` / `splitCheckedAt` on an org's payments still matches the
// subscriber's org filter, so each stamp used to re-run every open payments screen of that
// org for a result that had not changed. No filter on the document can tell that stamp from
// a status change; only the fields the update touched can.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { wrapDbWithAutoStamp } from "@/server/autoStamp"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const MODEL = "ignore_fields_payments"
let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(MODEL)

  query("igPayments", {
    args: v.object({ org: v.string(), ignore: v.boolean() }),
    handler: async (args, ctx) => {
      ctx.watch(MODEL, { org: args.org }, args.ignore ? { ignoreFields: ["reconciledAt"] } : undefined)
      return await ctx.db.model(MODEL).find({ org: args.org }).toArray()
    },
  })
  // A pipeline with a non-$match stage: a change stream of its own, not the shared hub.
  query("igPaymentsPipeline", {
    args: v.object({ org: v.string() }),
    handler: async (args, ctx) => {
      ctx.watch(
        MODEL,
        [{ $match: { "fullDocument.org": args.org } }, { $project: { operationType: 1, fullDocument: 1, updateDescription: 1 } }],
        { ignoreFields: ["reconciledAt"] }
      )
      return await ctx.db.model(MODEL).find({ org: args.org }).toArray()
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
  await DB.model(MODEL).insertOne({ _id: "p1" as any, org: "a", status: "open" })
})

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
// Through the db proxy, as a cron handler writes: it stamps updatedAt alongside.
const payments = () => wrapDbWithAutoStamp(DB).model(MODEL)
const results = (client: ReturnType<typeof createWsClient>) => client.inbox.filter((m) => m.type === "QueryResult")

async function subscribe(msg: any) {
  const client = createWsClient(`ws://localhost:${port}/ws`)
  await client.open()
  client.send(msg)
  await client.waitFor((m) => m.type === "QueryResult" && m.success)
  await settle()
  return client
}

describe("attachWs: ignoreFields", () => {
  for (const [label, msg] of [
    ["shared hub watch", { type: "query", name: "igPayments", args: { org: "a", ignore: true } }],
    ["own change stream", { type: "query", name: "igPaymentsPipeline", args: { org: "a" } }],
  ] as const) {
    it(`${label}: a cron stamp does not re-run; a real change does`, async () => {
      const client = await subscribe(msg)
      await payments().updateOne({ _id: "p1" }, { $set: { reconciledAt: Date.now() } })
      await settle()
      expect(results(client)).toHaveLength(1)

      await payments().updateOne({ _id: "p1" }, { $set: { status: "paid" } })
      const rerun = await client.waitFor((m) => m.type === "QueryResult" && m.data?.[0]?.status === "paid")
      expect(rerun.success).toBe(true)
      await client.close()
    })
  }

  it("without the option, a cron stamp re-runs the query as it always did", async () => {
    const client = await subscribe({ type: "query", name: "igPayments", args: { org: "a", ignore: false } })
    await payments().updateOne({ _id: "p1" }, { $set: { reconciledAt: Date.now() } })
    await client.waitFor((m) => m.type === "QueryResult" && results(client).length === 2)
    await client.close()
  })
})
