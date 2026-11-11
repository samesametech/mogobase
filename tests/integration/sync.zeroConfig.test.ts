// Sync out of the box (owner requirement, 4.0.0): for a model declared `sync: true`, a client
// syncs and keeps syncing with NO option set — none on the server (`attachMogobaseWebSocket(
// server)`: no policy, no tuning) and none on the client (`startSync()`). If any of this ever
// needs configuring, these fail.
//
// The real client engines run here, as shipped — RxDB's on its Dexie storage (over an in-memory
// IndexedDB, fake-indexeddb, since Node has none) and WatermelonDB's on LokiJS. Each
// loses its socket twice — killed, and the server stopped and attached again — and must
// reconnect by itself, pull what was written meanwhile, then hear later writes live. Then the
// server's own change stream for the model is closed under it: the server must reopen it and
// make the client pull what was written while it was down.
//
// Where the server is: a browser client takes it from window.location. A Node host has none, so
// the engines read MOGOBASE_URL — set here to the test server, as an SSR host would.
import "fake-indexeddb/auto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { type ChangeStream, Collection } from "mongodb"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const RX_MODEL = "zero_config_rx"
const WM_MODEL = "zero_config_wm"
let server: http.Server
let wss: ReturnType<typeof attachMogobaseWebSocket>
const streams: { model: string; cs: ChangeStream }[] = []

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(RX_MODEL, undefined, { sync: true })
  defineModel(WM_MODEL, undefined, { sync: true })
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [RX_MODEL, WM_MODEL])
  await client.close()
  const realWatch = Collection.prototype.watch
  vi.spyOn(Collection.prototype, "watch").mockImplementation(function (this: Collection, ...a: any[]) {
    const cs = (realWatch as any).apply(this, a)
    streams.push({ model: this.collectionName, cs })
    return cs
  })
  server = http.createServer()
  wss = attachMogobaseWebSocket(server) // no options at all
  await new Promise<void>((res) => server.listen(0, res))
  process.env.MOGOBASE_URL = `ws://localhost:${(server.address() as AddressInfo).port}/ws`
})

afterAll(async () => {
  vi.restoreAllMocks()
  await wss.stop()
  await new Promise<void>((res) => server.close(() => res()))
  delete process.env.MOGOBASE_URL
})

const write = (model: string, _id: string) =>
  DB.model(model).insertOne({ _id: _id as any, text: _id, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null })

const killSockets = () => {
  for (const ws of wss.clients) ws.terminate()
}

// The server's change streams on `model`, closed from outside — as an invalidate or a dropped
// connection ends them — not by the server.
const killServerStreams = async (model: string) => {
  const open = streams.filter((s) => s.model === model && !s.cs.closed)
  expect(open.length).toBeGreaterThan(0)
  for (const s of open) await s.cs.close()
}

const restartServer = async () => {
  await wss.stop()
  wss = attachMogobaseWebSocket(server)
}

async function proveReconnects(model: string, has: (id: string) => Promise<boolean>) {
  const arrives = (id: string) => vi.waitFor(async () => expect(await has(id)).toBe(true), { timeout: 15_000, interval: 200 })
  await write(model, "live-1")
  await arrives("live-1") // syncing, live

  killSockets()
  await write(model, "while-killed")
  await arrives("while-killed") // reconnected on its own, and pulled what it missed
  await write(model, "after-kill")
  await arrives("after-kill") // and hears writes live again

  await restartServer()
  await write(model, "while-restarting")
  await arrives("while-restarting")
  await write(model, "after-restart")
  await arrives("after-restart")

  await killServerStreams(model)
  await write(model, "while-stream-down")
  await arrives("while-stream-down") // reopened by the server, which made the client pull
  await write(model, "after-stream-reopen")
  await arrives("after-stream-reopen")
}

describe("sync with no configuration (owner requirement, 4.0.0)", () => {
  it("an RxDB client reconnects by itself, pulls what it missed, and hears later writes", async () => {
    const { default: clientDB } = await import("@/client/db/rxdb")
    await clientDB.connect(`zero_config_rx_${Date.now()}`)
    await clientDB.defineModel(RX_MODEL)
    await clientDB.startSync() // no options
    try {
      await proveReconnects(RX_MODEL, async (id) => !!(await clientDB.model(RX_MODEL).findOne({ _id: id })))
    } finally {
      await clientDB.stopSync()
      await clientDB.disconnect()
    }
  }, 90_000)

  it("a WatermelonDB client reconnects by itself, pulls what it missed, and hears later writes", async () => {
    const { default: clientDB } = await import("@/client/db/watermelon")
    await clientDB.connect(`zero_config_wm_${Date.now()}`)
    await clientDB.defineModel(WM_MODEL)
    await clientDB.startSync() // no options
    try {
      await proveReconnects(WM_MODEL, async (id) => !!(await clientDB.model(WM_MODEL).findOne({ _id: id })))
    } finally {
      await clientDB.destroy?.()
    }
  }, 90_000)
})
