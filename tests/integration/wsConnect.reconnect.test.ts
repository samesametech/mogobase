import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { getTestMongoUri } from "../helpers/mongo"
import DB from "@/db"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"
import { openResilientWs } from "@/client/hooks/wsConnect"

let server: http.Server
let wss: ReturnType<typeof attachMogobaseWebSocket>

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  query("wsConnectProbe", {
    args: v.object({}),
    handler: async () => "pong",
  })
  server = http.createServer()
  wss = attachMogobaseWebSocket(server, "/ws")
  await new Promise<void>((res) => server.listen(0, res))
  const port = (server.address() as AddressInfo).port
  // openResilientWs builds its URL from this on every (re)connect
  process.env.MOGOBASE_URL = `http://localhost:${port}`
})

afterAll(async () => {
  delete process.env.MOGOBASE_URL
  await new Promise<void>((res) => server.close(() => res()))
})

describe("openResilientWs", () => {
  it("re-subscribes after the server drops the socket", async () => {
    const results: any[] = []
    const conn = openResilientWs({
      label: "test",
      subscribeMsg: () => ({ type: "query", name: "wsConnectProbe", args: {} }),
      onMessage: (m) => {
        if (m.type === "QueryResult") results.push(m)
      },
    })
    await vi.waitFor(() => expect(results.length).toBeGreaterThanOrEqual(1))

    // Drop every socket server-side, as a proxy idle-timeout or a deploy would.
    for (const client of wss.clients) client.terminate()

    // Retry starts at 1 s; a second QueryResult proves reconnect + re-subscribe.
    await vi.waitFor(() => expect(results.length).toBeGreaterThanOrEqual(2), { timeout: 5000, interval: 100 })
    expect(results[1].data).toBe("pong")
    conn.close()
  })

  it("stops reconnecting once closed", async () => {
    const results: any[] = []
    const conn = openResilientWs({
      label: "test-closed",
      subscribeMsg: () => ({ type: "query", name: "wsConnectProbe", args: {} }),
      onMessage: (m) => {
        if (m.type === "QueryResult") results.push(m)
      },
    })
    await vi.waitFor(() => expect(results.length).toBe(1))
    conn.close()
    for (const client of wss.clients) client.terminate()
    await new Promise((r) => setTimeout(r, 1500))
    expect(results.length).toBe(1)
  })
})
