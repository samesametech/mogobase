import { describe, it, expect, beforeAll, afterAll } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import WebSocket from "ws"
import { getTestMongoUri } from "../helpers/mongo"
import DB from "@/db"
import { attachMogobaseWebSocket } from "@/server/attachWs"

let server: http.Server
let port: number

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { heartbeatMs: 100 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
})

describe("attachWs heartbeat", () => {
  it("pings connected clients on the interval", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res())
      ws.once("error", rej)
    })
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("no ping within 1s")), 1000)
      ws.once("ping", () => {
        clearTimeout(t)
        res()
      })
    })
    ws.close()
  })

  it("terminates clients that never pong", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, { autoPong: false })
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res())
      ws.once("error", rej)
    })
    // First tick marks the socket stale, second terminates it.
    const code = await new Promise<number>((res, rej) => {
      const t = setTimeout(() => rej(new Error("not terminated within 1s")), 1000)
      ws.once("close", (c) => {
        clearTimeout(t)
        res(c)
      })
    })
    expect(code).toBe(1006)
  })
})
