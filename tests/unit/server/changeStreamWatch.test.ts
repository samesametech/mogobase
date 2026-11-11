// Watch options: mogobase's own keys stay with mogobase; the rest go to the driver.
import { describe, expect, it, vi } from "vitest"
import { openChangeStreamWatch, splitWatchOptions, streamStarted, watchKey } from "@/server/changeStreamWatch"
import { EventEmitter } from "events"

describe("splitWatchOptions", () => {
  it("keeps ignoreFields, paginatedField and sortAscending away from the driver", () => {
    const { driverOptions, ignoreFields } = splitWatchOptions({
      ignoreFields: ["reconciledAt"],
      paginatedField: "createdAt",
      sortAscending: true,
      batchSize: 5,
      startAfter: { _data: "T" },
    })
    expect(driverOptions).toEqual({ batchSize: 5, startAfter: { _data: "T" } })
    expect(ignoreFields).toEqual(["reconciledAt", "updatedAt"])
  })

  it("no options, no driver options", () => {
    expect(splitWatchOptions(undefined)).toEqual({ driverOptions: {} })
  })

  it("hands dbName back to mogobase, never to the driver", () => {
    expect(splitWatchOptions({ dbName: "identity", batchSize: 5 })).toEqual({ driverOptions: { batchSize: 5 }, dbName: "identity" })
    expect(splitWatchOptions({ dbName: "" })).toEqual({ driverOptions: {} })
  })

  it("drops fullDocument and fullDocumentBeforeChange: a pre-image is never read, and asking for one can kill the watch", () => {
    const { driverOptions } = splitWatchOptions({ fullDocument: "whenAvailable", fullDocumentBeforeChange: "required", batchSize: 10 })
    expect(driverOptions).toEqual({ batchSize: 10 })
  })
})

describe("watchKey", () => {
  const base = { kind: "hub" as const, dbName: "db", model: "m", filter: { a: 1, b: 2 } }
  it("equal watches get equal keys, whatever the property order", () => {
    expect(watchKey(base)).toBe(watchKey({ ...base, filter: { b: 2, a: 1 } }))
  })
  it("any difference that makes it another watch makes another key", () => {
    const key = watchKey(base)
    expect(watchKey({ ...base, kind: "stream" })).not.toBe(key)
    expect(watchKey({ ...base, dbName: "other" })).not.toBe(key)
    expect(watchKey({ ...base, filter: { a: 2, b: 2 } })).not.toBe(key)
    expect(watchKey({ ...base, ignoreFields: ["x", "updatedAt"] })).not.toBe(key)
    expect(watchKey({ ...base, driverOptions: { batchSize: 5 } })).not.toBe(key)
  })
})

describe("a watch is open once its stream runs (review round 4)", () => {
  class Starting extends EventEmitter {
    async close() {}
  }

  it("openChangeStreamWatch resolves only when the stream has started on the server", async () => {
    const stream = new Starting()
    let resolved = false
    const opening = openChangeStreamWatch({
      collection: { watch: () => stream },
      model: "m",
      pipeline: [],
      options: {},
      onEvent: () => {},
      label: "test",
    }).then(() => (resolved = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(resolved).toBe(false) // watch() returned, but the aggregate has not been answered
    stream.emit("resumeTokenChanged", { _data: "T0" })
    await opening
    expect(resolved).toBe(true)
  })

  it("streamStarted gives up waiting on an error, a close, or the timeout", async () => {
    for (const end of ["error", "close"]) {
      const stream = new Starting()
      stream.on("error", () => {})
      const started = streamStarted(stream)
      stream.emit(end, new Error("x"))
      await started
    }
    await streamStarted(new Starting(), 10)
  })
})

describe("openSpecWatch (review round F10)", () => {
  it("refuses a spec with no db or pipeline, naming its model, instead of failing deep in the open", async () => {
    const { openSpecWatch } = await import("@/server/changeStreamWatch")
    expect(() => openSpecWatch({ model: "orders", pipeline: [] }, () => {}, () => {}, "test")).toThrow(/orders has no db or pipeline/)
    expect(() => openSpecWatch({ model: "orders", db: { model: () => ({}) } }, () => {}, () => {}, "test")).toThrow(/no db or pipeline/)
  })
})

describe("warnUnnarrowed (review round F15)", () => {
  // Keyed by (collection, operator) only, a live-query warning silenced the sync stream's for the
  // same collection and operator, and its text said a sync stream "re-runs" — it makes clients pull.
  it("warns once per kind of watch, in that kind's words", async () => {
    const { warnUnnarrowed } = await import("@/server/changeStreamWatch")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    warnUnnarrowed("db", "f15_orders", "$text", "live-query watch")
    warnUnnarrowed("db", "f15_orders", "$text", "live-query watch")
    warnUnnarrowed("db", "f15_orders", "$text", "sync stream")
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0][0])).toMatch(/re-runs it/)
    expect(String(warn.mock.calls[1][0])).toMatch(/subscribed clients pull/)
    warn.mockRestore()
  })
})

describe("warnOwnStream (review round F16)", () => {
  // Keyed by (collection, reason) only: a live query's own-stream warning silenced the sync
  // stream's for the same collection and reason — a pooled connection per client unreported.
  it("warns once per kind of watch", async () => {
    const { warnOwnStream } = await import("@/server/changeStreamWatch")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    warnOwnStream("db", "f16_orders", "operator $elemMatch", "live-query watch")
    warnOwnStream("db", "f16_orders", "operator $elemMatch", "live-query watch")
    warnOwnStream("db", "f16_orders", "operator $elemMatch", "sync stream")
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
