// tests/unit/db/indexBridge.test.ts
//
// Regression: a model registered through runtime.defineModel({ indexSpecs })
// must have those indexes applied when MogobaseDB.connect() brings it online.
// The onModel bridge previously read a nonexistent `m.indexes` field (models
// declare `indexSpecs`), so NO custom index — e.g. a unique dedup guard — was
// ever created. We drive a real connect() against a fake MongoClient and assert
// the custom index reaches createIndexes alongside the sync-checkpoint indexes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { MongoClient } from "mongodb"

type FakeCollection = { _indexes: any[]; createIndexes: (specs: any[]) => Promise<string[]> }

function makeFakeCollection(): FakeCollection {
  const indexes: any[] = []
  return {
    _indexes: indexes,
    createIndexes: async (specs: any[]) => {
      for (const s of specs) indexes.push(s)
      return specs.map((s) => s?.name ?? "idx")
    },
  }
}

function clearRegistry() {
  for (const key of Object.keys(globalThis as any)) {
    if (key.includes("mogobase") && key.includes("models")) {
      const slot = (globalThis as any)[key]
      if (slot?.models) slot.models.length = 0
      if (slot?.listeners) slot.listeners.length = 0
    }
  }
}

describe("runtime defineModel → connect() index bridge", () => {
  beforeEach(() => {
    clearRegistry()
    const anyDb = DB as any
    anyDb._mongoClient = undefined
    anyDb._db = undefined
    anyDb._modelsBound = false
    anyDb._clients?.clear?.()
    anyDb._views?.clear?.()
    anyDb._appliedModels?.clear?.()
    anyDb._schemas?.clear?.()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    clearRegistry()
  })

  it("applies a model's indexSpecs (incl. unique) through the bridge", async () => {
    const specs = [
      { key: { gatewayCode: 1, gatewayEventId: 1 }, unique: true, name: "webhook_dedup" },
      { key: { expiresAt: 1 }, name: "webhook_ttl", expireAfterSeconds: 0 },
    ]
    defineModel("webhook_events", undefined, { sync: false, indexSpecs: specs })

    const col = makeFakeCollection()
    const fakeDb = { collection: () => col }
    vi.spyOn(MongoClient, "connect").mockResolvedValue({ db: () => fakeDb, close: async () => {} } as any)

    await DB.connect()
    // The bridge's defineModel() is fire-and-forget inside connect(); let its
    // createIndexes calls settle.
    await new Promise((r) => setTimeout(r, 10))

    const names = col._indexes.map((s) => s?.name)
    expect(names).toContain("webhook_dedup")
    expect(names).toContain("webhook_ttl")
    // Sync-checkpoint indexes still applied on top.
    expect(names).toContain("mogobase_updatedAt_1")
    // The unique flag survives the envelope round-trip.
    expect(col._indexes.find((s) => s?.name === "webhook_dedup")?.unique).toBe(true)
  })
})
