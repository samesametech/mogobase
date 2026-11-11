// Concurrent connect() calls share one connection: at boot every socket's first message awaits
// connect(), and each used to open a client of its own (the last one won, the rest leaked).
import { describe, expect, it, vi } from "vitest"
import { MongoClient } from "mongodb"
import { getTestMongoUri } from "../helpers/mongo"
import DB from "@/db"

describe("connect() (review round 8)", () => {
  it("concurrent callers get one client", async () => {
    process.env.MONGO_URI = getTestMongoUri()
    process.env.MONGO_DB = "mogobase_test_integration"
    await DB.connect()
    await DB.disconnect()
    const spy = vi.spyOn(MongoClient, "connect")
    try {
      const dbs = await Promise.all([DB.connect(), DB.connect(), DB.connect()])
      expect(spy).toHaveBeenCalledTimes(1)
      expect(new Set(dbs).size).toBe(1)
      expect((DB as any)._clients.size).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("connect() and disconnect() (review round 9)", () => {
  it("a disconnect while a connect is in flight leaves nothing connected", async () => {
    await DB.connect()
    await DB.disconnect()
    const connecting = DB.connect()
    await DB.disconnect()
    await connecting
    expect((DB as any)._mongoClient).toBeUndefined()
    expect((DB as any)._clients.size).toBe(0)
    await DB.connect() // for whatever runs next
  })

  it("a model registered again after connect is built from its merged definition", async () => {
    const { defineModel } = await import("@/runtime/models")
    const { z } = await import("zod/v4")
    await DB.connect()
    defineModel("r9_redefined", undefined, { indexSpecs: [{ key: { k: 1 }, name: "k_1" }] })
    defineModel("r9_redefined", { title: z.string() }) // a schema, no indexSpecs: they still stand
    await vi.waitFor(() => expect((DB as any)._schemas.get("r9_redefined")?.schema).toBeDefined())
    expect((DB as any)._schemas.get("r9_redefined").indexes).toEqual({ indexSpecs: [{ key: { k: 1 }, name: "k_1" }] })
    const diff = await DB.diffIndexes("r9_redefined")
    expect(diff.declared.map((d: any) => d.name)).toContain("k_1")
  })

  it("indexReport lists a few databases at a time, not all at once", async () => {
    const { Db } = await import("mongodb")
    const { defineModel } = await import("@/runtime/models")
    defineModel("r9_report")
    const dbNames = Array.from({ length: 12 }, (_, i) => `mogobase_test_r9_report_${i}`)
    let inFlight = 0
    let most = 0
    const realList = Db.prototype.listCollections
    const spy = vi.spyOn(Db.prototype, "listCollections").mockImplementation(function (this: any, ...a: any[]) {
      const cursor = (realList as any).apply(this, a)
      if (!dbNames.includes(this.databaseName) || a.length) return cursor
      return {
        toArray: async () => {
          most = Math.max(most, ++inFlight)
          await new Promise((r) => setTimeout(r, 20))
          inFlight--
          return cursor.toArray()
        },
      } as any
    })
    try {
      await DB.indexReport({ models: ["r9_report"], dbNames })
    } finally {
      spy.mockRestore()
    }
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(8)
  })
})

describe("connect() during disconnect() (review round 11)", () => {
  it("gets a fresh connection, not the closing one", async () => {
    await DB.connect()
    const closing = DB.disconnect()
    const db = await DB.connect() // a socket's message during shutdown
    await closing
    await expect(db.collection("r11_probe").countDocuments({})).resolves.toBeTypeOf("number")
  })
})

describe("connect() while disconnect() waits for a connect in flight (review round 12)", () => {
  it("gets a fresh client, not the one the disconnect is about to close", async () => {
    await DB.connect()
    await DB.disconnect()
    const inFlight = DB.connect()
    const closing = DB.disconnect() // waits for the in-flight connect, then closes it
    const during = DB.connect() // a socket's message meanwhile
    await closing
    await inFlight
    const db = await during
    await expect(db.collection("r12_probe").countDocuments({})).resolves.toBeTypeOf("number")
  })
})
