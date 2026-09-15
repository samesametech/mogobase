import http from "http"
import { AddressInfo } from "net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import DB from "@/db"
import { mutation, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"
import { createWsClient } from "../helpers/wsClient"
import { getTestMongoUri } from "../helpers/mongo"

// The socket serves QUERIES. Mutations have always gone over HTTP — `useMutation` POSTs to
// /api/handlers whenever it is online — so this branch served no first-party caller while
// still running the full public mutation set under the handshake's session.
//
// That made it a second write door, invisible to anything an app wraps around its HTTP
// routes: an audit trail, a request id, a tenant stamp. Authorization was identical, so
// nothing looked wrong; the write was simply unattributed. Closed in 3.10.0.
//
// This test fails open in the worst way if deleted — the door reopens, every mutation keeps
// working, and the only symptom is a write nobody can attribute. Do not "fix" a red here by
// restoring the branch.
let server: http.Server
let port: number
let ran = 0

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()

  mutation("wsRefusalProbe", {
    args: v.object({}),
    handler: async () => {
      ran++
      return { ok: true }
    },
  })

  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws")
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
})

describe("attachWs mutation frames", () => {
  it("refuses a mutation frame and names where it belongs", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "mutation", id: "m1", name: "wsRefusalProbe", args: {} })

    const msg = await client.waitFor((m) => m.type === "MutationResult")
    expect(msg.success).toBe(false)
    expect(msg.error).toContain("/api/handlers")
    await client.close()
  })

  it("does not run the handler", async () => {
    // The refusal has to come BEFORE the handler, not after it. A frame that ran the mutation
    // and then reported failure would be the worst of both: the write lands, the caller
    // retries, and the trail still names nobody.
    expect(ran).toBe(0)
  })

  it("still answers queries on the same socket", async () => {
    // The door closed is the mutation one only — live queries are what /ws is for.
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", id: "q1", name: "noSuchQuery", args: {} })
    const msg = await client.waitFor((m) => m.type === "QueryResult")
    expect(msg.success).toBe(false)
    expect(msg.error).toContain("not found")
    await client.close()
  })
})
