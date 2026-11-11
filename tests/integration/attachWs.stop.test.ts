// stop() closes the clients (1001): wss.close() alone left their sockets open, talking to a hub
// that had shut down (review round 8).
import { beforeAll, describe, expect, it } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { attachMogobaseWebSocket } from "@/server/attachWs"

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
})

describe("attachWs stop()", () => {
  it("closes every client socket with 1001, so it reconnects to whatever attaches next", async () => {
    const server = http.createServer()
    const wss = attachMogobaseWebSocket(server, "/ws")
    await new Promise<void>((res) => server.listen(0, res))
    const port = (server.address() as AddressInfo).port
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    const closed = new Promise<number>((res) => client.ws.once("close", (code: number) => res(code)))
    await wss.stop()
    expect(await closed).toBe(1001)
    await new Promise<void>((res) => server.close(() => res()))
  })
})
