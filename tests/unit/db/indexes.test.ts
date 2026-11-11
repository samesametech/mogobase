// Declared vs actual index matching, without a database.
import { describe, expect, it, vi } from "vitest"
import { diffIndexSpecs } from "@/db/indexes"
import { defineModel, getStampIndexFields } from "@/runtime/models"

const id = { key: { _id: 1 }, name: "_id_" }

describe("diffIndexSpecs", () => {
  it("matches by key, not name, and reports what is missing and undeclared", () => {
    const diff = diffIndexSpecs(
      "m",
      "db",
      [{ key: { org: 1, createdAt: -1 } }, { key: { email: 1 }, unique: true }],
      [id, { key: { org: 1, createdAt: -1 }, name: "renamed" }, { key: { legacy: 1 }, name: "legacy_1" }]
    )
    expect(diff.missing.map((s) => s.key)).toEqual([{ email: 1 }])
    expect(diff.undeclared.map((i) => i.name)).toEqual(["legacy_1"])
    expect(diff.conflicting).toEqual([])
  })

  it("key order and direction matter", () => {
    const diff = diffIndexSpecs("m", "db", [{ key: { a: 1, b: 1 } }], [id, { key: { b: 1, a: 1 }, name: "b_1_a_1" }])
    expect(diff.missing).toHaveLength(1)
    expect(diff.undeclared).toHaveLength(1)
  })

  it("an index on the declared key with other options is conflicting, not undeclared", () => {
    const diff = diffIndexSpecs(
      "m",
      "db",
      [{ key: { email: 1 }, unique: true, name: "email_unique" }, { key: { at: 1 }, expireAfterSeconds: 60 }],
      [id, { key: { email: 1 }, name: "email_1" }, { key: { at: 1 }, name: "at_1", expireAfterSeconds: 3600 }]
    )
    expect(diff.conflicting.map((c) => c.differs)).toEqual([["unique", "name"], ["expireAfterSeconds"]])
    expect(diff.undeclared).toEqual([])
    expect(diff.missing).toEqual([])
  })

  it("a declared text index matches the collection's text index", () => {
    const diff = diffIndexSpecs("m", "db", [{ key: { title: "text" } }], [id, { key: { _fts: "text", _ftsx: 1 }, name: "title_text" }])
    expect(diff.missing).toEqual([])
    expect(diff.undeclared).toEqual([])
  })

  it("a tolerated index is neither missing nor undeclared", () => {
    const diff = diffIndexSpecs("m", "db", [], [id, { key: { sensor: 1, ts: 1 }, name: "sensor_1_ts_1" }], [{ key: { sensor: 1, ts: 1 } }])
    expect(diff.undeclared).toEqual([])
  })
})

describe("stampIndexes option", () => {
  it("defaults to all three, and turns off the ones set to false", () => {
    defineModel("stampIdx_default")
    defineModel("stampIdx_partial", undefined, { stampIndexes: { createdAt: false, deletedAt: false } })
    defineModel("stampIdx_none", undefined, { stampIndexes: false })
    expect(getStampIndexFields("stampIdx_default")).toEqual(["updatedAt", "deletedAt", "createdAt"])
    expect(getStampIndexFields("stampIdx_partial")).toEqual(["updatedAt"])
    expect(getStampIndexFields("stampIdx_none")).toEqual([])
    expect(getStampIndexFields("stampIdx_never_defined")).toEqual(["updatedAt", "deletedAt", "createdAt"])
  })
})

describe("diffIndexSpecs: keys and options it used to miss", () => {
  it("a key given as a Map matches the index it built", () => {
    const declared = [{ key: new Map([["a", 1], ["b", -1]]), name: "a_b" } as any]
    const diff = diffIndexSpecs("m", "db", declared, [id, { key: { a: 1, b: -1 }, name: "a_b" }])
    expect(diff.missing).toEqual([])
    expect(diff.undeclared).toEqual([])
    expect(diffIndexSpecs("m", "db", declared, [id, { key: { b: -1, a: 1 }, name: "b_a" }]).missing).toHaveLength(1)
  })

  it("collation: compared on the fields the spec states; none on one side is the simple collation", () => {
    const filledIn = { locale: "en", caseLevel: false, strength: 2, numericOrdering: false, version: "57.1" }
    const collated = { key: { name: 1 }, name: "name_ci", collation: { locale: "en", strength: 2 } }
    expect(diffIndexSpecs("m", "db", [collated], [id, { key: { name: 1 }, name: "name_ci", collation: filledIn }]).conflicting).toEqual([])
    expect(
      diffIndexSpecs("m", "db", [collated], [id, { key: { name: 1 }, name: "name_ci", collation: { ...filledIn, strength: 3 } }])
        .conflicting.map((c) => c.differs)
    ).toEqual([["collation"]])
    expect(diffIndexSpecs("m", "db", [collated], [id, { key: { name: 1 }, name: "name_ci" }]).conflicting.map((c) => c.differs)).toEqual([
      ["collation"],
    ])
  })

  it("a collated and a plain index on one key: the declared one is kept, the other is undeclared", () => {
    const collated = { key: { name: 1 }, name: "name_ci", collation: { locale: "en", strength: 2 } }
    const plain = { key: { name: 1 }, name: "name_1" }
    const withCollation = { key: { name: 1 }, name: "name_ci", collation: { locale: "en", strength: 2, caseLevel: false } }
    for (const actual of [[id, plain, withCollation], [id, withCollation, plain]]) {
      const diff = diffIndexSpecs("m", "db", [collated], actual)
      expect(diff.conflicting).toEqual([])
      expect(diff.undeclared.map((i) => i.name)).toEqual(["name_1"])
    }
  })

  it("hidden, and a text index's fields and weights, are compared", () => {
    expect(diffIndexSpecs("m", "db", [{ key: { a: 1 } }], [id, { key: { a: 1 }, name: "a_1", hidden: true }]).conflicting[0].differs).toEqual([
      "hidden",
    ])
    const text = { _fts: "text", _ftsx: 1 }
    expect(diffIndexSpecs("m", "db", [{ key: { title: "text" } }], [id, { key: text, name: "t", weights: { title: 1 } }]).conflicting).toEqual([])
    expect(
      diffIndexSpecs("m", "db", [{ key: { title: "text" } }], [id, { key: text, name: "t", weights: { title: 1, body: 1 } }]).conflicting[0]
        .differs
    ).toEqual(["weights"])
    expect(
      diffIndexSpecs("m", "db", [{ key: { title: "text" }, weights: { title: 5 } } as any], [id, { key: text, name: "t", weights: { title: 5 } }])
        .conflicting
    ).toEqual([])
  })
})

describe("building indexes: a cluster failure vs a bad spec", () => {
  const specs = [{ key: { a: 1 } }, { key: { b: 1 } }, { key: { c: 1 } }]
  async function build(error: any) {
    const { default: DB } = await import("@/db")
    const calls: any[][] = []
    const collection: any = {
      createIndexes: async (batch: any[]) => {
        calls.push(batch)
        throw error
      },
    }
    const events: any[] = []
    const off = DB.onIndexError((e) => events.push(e))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    ;(DB as any)._indexRetryDelaysMs = [] // no retry here: this is about the first attempt
    try {
      await (DB as any)._buildIndexes({ databaseName: "db" }, collection, "m", specs, undefined, "custom indexes")
    } finally {
      ;(DB as any)._indexRetryDelaysMs = undefined
      off()
      warn.mockRestore()
    }
    return { calls, events }
  }

  it("no primary: one attempt, one report naming the whole batch — not one per spec", async () => {
    const { calls, events } = await build(Object.assign(new Error("not primary"), { code: 10107 }))
    expect(calls).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(events[0].specs).toEqual(specs)
    expect(events[0].spec).toEqual(specs[0])
  })

  it("a refused spec: each spec is tried alone, and each failure reported", async () => {
    const { calls, events } = await build(Object.assign(new Error("index options conflict"), { code: 85 }))
    expect(calls).toHaveLength(4)
    expect(events.map((e) => e.specs)).toEqual(specs.map((s) => [s]))
  })
})

describe("building indexes: a cluster failure is retried (review round 2)", () => {
  const specs = [{ key: { a: 1 } }, { key: { b: 1 } }]
  async function build(failures: number) {
    const { default: DB } = await import("@/db")
    let calls = 0
    const collection: any = {
      createIndexes: async () => {
        if (calls++ < failures) throw Object.assign(new Error("not primary"), { code: 10107 })
      },
    }
    const events: any[] = []
    const off = DB.onIndexError((e) => events.push(e))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    ;(DB as any)._indexRetryDelaysMs = [5, 5]
    try {
      await (DB as any)._buildIndexes({ databaseName: "db" }, collection, "m", specs, undefined, "custom indexes")
      await new Promise((r) => setTimeout(r, 60))
    } finally {
      ;(DB as any)._indexRetryDelaysMs = undefined
      off()
      warn.mockRestore()
    }
    return { calls, events }
  }

  it("an election that ends in time: built on a retry, reported once", async () => {
    const { calls, events } = await build(2)
    expect(calls).toBe(3)
    expect(events).toHaveLength(1)
  })

  it("a failure that outlasts every retry: reported at the start and when it gives up", async () => {
    const { calls, events } = await build(99)
    expect(calls).toBe(3)
    expect(events).toHaveLength(2)
  })
})

describe("building indexes: review round 3", () => {
  const specs = [{ key: { a: 1 } }, { key: { b: 1 } }, { key: { c: 1 } }]
  const conflict = () => Object.assign(new Error("index options conflict"), { code: 85 })
  const noPrimary = () => Object.assign(new Error("not primary"), { code: 10107 })

  it("a failover in the middle of the one-by-one builds retries the specs it left unbuilt", async () => {
    const { default: DB } = await import("@/db")
    const calls: any[][] = []
    let electing = true
    const collection: any = {
      createIndexes: async (batch: any[]) => {
        calls.push(batch)
        if (batch.length > 1 && calls.length === 1) throw conflict() // the batch: one bad spec
        if (batch[0].key.a) throw conflict() // spec a is refused for good
        if (electing) throw noPrimary() // spec b meets an election
      },
    }
    const events: any[] = []
    const off = DB.onIndexError((e) => events.push(e))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    ;(DB as any)._indexRetryDelaysMs = [20]
    try {
      await (DB as any)._buildIndexes({ databaseName: "db" }, collection, "m", specs, undefined, "custom indexes")
      electing = false
      await vi.waitFor(() => expect(calls.some((b) => b.length === 2 && b[0].key.b && b[1].key.c)).toBe(true))
    } finally {
      ;(DB as any)._indexRetryDelaysMs = undefined
      off()
      warn.mockRestore()
    }
    // a: refused, reported alone. b and c: reported once together, then built on the retry.
    expect(events.map((e) => e.specs)).toEqual([[specs[0]], [specs[1], specs[2]]])
  })

  it("disconnect() cancels a pending retry", async () => {
    const { default: DB } = await import("@/db")
    let calls = 0
    const collection: any = {
      createIndexes: async () => {
        calls++
        throw noPrimary()
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    ;(DB as any)._indexRetryDelaysMs = [20, 20]
    try {
      await (DB as any)._buildIndexes({ databaseName: "db" }, collection, "m", specs, undefined, "custom indexes")
      expect(calls).toBe(1)
      await DB.disconnect()
      await new Promise((r) => setTimeout(r, 80))
      expect(calls).toBe(1)
    } finally {
      ;(DB as any)._indexRetryDelaysMs = undefined
      warn.mockRestore()
    }
  })
})

describe("building indexes: review round 4", () => {
  it("a build that fails after disconnect() neither retries nor reports", async () => {
    const { default: DB } = await import("@/db")
    const specs = [{ key: { a: 1 } }]
    let release: (() => void) | undefined
    let calls = 0
    const collection: any = {
      createIndexes: async () => {
        calls++
        await new Promise<void>((r) => (release = r))
        throw Object.assign(new Error("topology closed"), { name: "MongoTopologyClosedError" })
      },
    }
    const events: any[] = []
    const off = DB.onIndexError((e) => events.push(e))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    ;(DB as any)._indexRetryDelaysMs = [10]
    try {
      const building = (DB as any)._buildIndexes({ databaseName: "db" }, collection, "m", specs, undefined, "custom indexes")
      await vi.waitFor(() => expect(release).toBeDefined())
      await DB.disconnect() // the build is in flight…
      release!() // …and fails against the closed client afterwards
      await building
      await new Promise((r) => setTimeout(r, 50))
      expect(calls).toBe(1)
      expect(events).toEqual([])
    } finally {
      ;(DB as any)._indexRetryDelaysMs = undefined
      off()
      warn.mockRestore()
    }
  })
})

describe("index retry jitter (review round 7)", () => {
  it("spreads a delay by ±25%, so replicas that failed together do not retry together", async () => {
    const { jittered } = await import("@/db")
    expect(jittered(1000, 0)).toBe(750)
    expect(jittered(1000, 0.5)).toBe(1000)
    expect(jittered(1000, 0.999999)).toBe(1250)
  })
})

describe("building indexes: a batch error that names its spec (scalability review)", () => {
  const a = { key: { a: 1 } }
  const email = { key: { email: 1 }, unique: true }
  const ab = { key: { a: 1, b: -1 } }

  it("reports that spec and builds the rest in one batch, not one scan per spec", async () => {
    const { default: DB } = await import("@/db")
    const calls: any[][] = []
    const collection: any = {
      createIndexes: async (batch: any[]) => {
        calls.push(batch)
        if (batch.includes(email)) {
          throw Object.assign(new Error("Index build failed: E11000 duplicate key error collection: db.m index: email_1 dup key: { email: \"x\" }"), { code: 11000 })
        }
      },
    }
    const events: any[] = []
    const off = DB.onIndexError((e) => events.push(e))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await (DB as any)._buildIndexes({ databaseName: "db" }, collection, "m", [a, email, ab], undefined, "custom indexes")
    } finally {
      off()
      warn.mockRestore()
    }
    expect(calls).toEqual([[a, email, ab], [a, ab]])
    expect(events.map((e) => e.specs)).toEqual([[email]])
  })

  it("matches a name whole: a_1 is not named by an error about a_1_b_-1", async () => {
    const { specNamedInError } = await import("@/db/indexes")
    const err = new Error("index: a_1_b_-1 already exists with different options")
    expect(specNamedInError(err, [a, ab])).toBe(ab)
    expect(specNamedInError(new Error("no index named here"), [a, ab])).toBeUndefined()
  })
})

describe("model builds: review round 8", () => {
  it("a build that fails while disconnect() closes its client neither retries nor reports", async () => {
    const { default: DB } = await import("@/db")
    let failBuild: ((e: unknown) => void) | undefined
    const collection: any = {
      createIndexes: () => new Promise((_res, rej) => (failBuild = rej)),
    }
    // A client whose close() fails the build in flight, as the driver does, before it resolves.
    const fakeClient = {
      close: async () => {
        failBuild!(Object.assign(new Error("topology closed"), { name: "MongoTopologyClosedError" }))
        await new Promise((r) => setTimeout(r, 10))
      },
    }
    ;(DB as any)._clients.set("fake://", fakeClient)
    const events: any[] = []
    const off = DB.onIndexError((e) => events.push(e))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    ;(DB as any)._indexRetryDelaysMs = [10]
    try {
      const building = (DB as any)._buildIndexes({ databaseName: "db" }, collection, "m", [{ key: { a: 1 } }], undefined, "custom indexes")
      await vi.waitFor(() => expect(failBuild).toBeDefined())
      await DB.disconnect()
      await building
      await new Promise((r) => setTimeout(r, 40))
      expect(events).toEqual([])
    } finally {
      ;(DB as any)._indexRetryDelaysMs = undefined
      off()
      warn.mockRestore()
    }
  })

  it("during an outage, many first uses of a model start one retry chain, and build at most once a second", async () => {
    const { default: DB } = await import("@/db")
    let probes = 0
    const fakeDb: any = {
      databaseName: "tenant_x",
      listCollections: () => ({
        toArray: async () => {
          probes++
          throw Object.assign(new Error("not primary"), { code: 10107 })
        },
      }),
      collection: () => ({ createIndexes: async () => {} }),
    }
    ;(DB as any)._schemas.set("r8_outage", { timeseries: { timeField: "ts" } })
    ;(DB as any)._indexRetryDelaysMs = [60_000]
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      for (let i = 0; i < 5; i++) {
        ;(DB as any)._ensureModelApplied("mongodb://x", "tenant_x", fakeDb, "r8_outage")
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(probes).toBe(1) // five requests within a second: one build
      expect((DB as any)._indexRetryTimers.size).toBe(1)
      await new Promise((r) => setTimeout(r, 1050))
      ;(DB as any)._ensureModelApplied("mongodb://x", "tenant_x", fakeDb, "r8_outage")
      await new Promise((r) => setTimeout(r, 5))
      expect(probes).toBe(2) // a second later a use may try again (the cluster may be back)…
      expect((DB as any)._indexRetryTimers.size).toBe(1) // …without a second retry chain
    } finally {
      await DB.disconnect() // cancels the pending retry
      ;(DB as any)._indexRetryDelaysMs = undefined
      ;(DB as any)._schemas.delete("r8_outage")
      warn.mockRestore()
    }
  })
})

describe("model builds: review round 9", () => {
  it("a build that succeeds after failing leaves no throttle entry behind", async () => {
    const { default: DB } = await import("@/db")
    let fail = true
    const fakeDb: any = {
      databaseName: "tenant_r9",
      listCollections: () => ({
        toArray: async () => {
          if (fail) throw Object.assign(new Error("not primary"), { code: 10107 })
          return [{ name: "r9_heal", type: "timeseries" }]
        },
      }),
      collection: () => ({ createIndexes: async () => {} }),
    }
    ;(DB as any)._schemas.set("r9_heal", { timeseries: { timeField: "ts" } })
    ;(DB as any)._indexRetryDelaysMs = [60_000]
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      ;(DB as any)._ensureModelApplied("mongodb://x", "tenant_r9", fakeDb, "r9_heal")
      await new Promise((r) => setTimeout(r, 5))
      expect((DB as any)._lastFailedBuild.size).toBe(1)
      fail = false
      await new Promise((r) => setTimeout(r, 1050)) // past the first-use gap
      ;(DB as any)._ensureModelApplied("mongodb://x", "tenant_r9", fakeDb, "r9_heal")
      await new Promise((r) => setTimeout(r, 5))
      expect((DB as any)._lastFailedBuild.size).toBe(0)
    } finally {
      await DB.disconnect()
      ;(DB as any)._indexRetryDelaysMs = undefined
      ;(DB as any)._schemas.delete("r9_heal")
      warn.mockRestore()
    }
  })
})

describe("model builds: review round 13", () => {
  // The epoch was taken by each _buildIndexes when it started. A disconnect during the custom
  // indexes' build left the stamp indexes' build to start afterwards, on the new epoch: its
  // failure against the closed client was reported, and a retry timer set after the clear.
  it("a disconnect during a model's build: the builds after it neither report nor retry", async () => {
    const { default: DB } = await import("@/db")
    let release: (() => void) | undefined
    let calls = 0
    const closed = () => Object.assign(new Error("topology closed"), { name: "MongoTopologyClosedError" })
    const collection: any = {
      createIndexes: async () => {
        if (calls++ === 0) await new Promise<void>((r) => (release = r))
        throw closed()
      },
    }
    const fakeDb: any = { databaseName: "tenant_r13", collection: () => collection }
    const events: any[] = []
    const off = DB.onIndexError((e) => events.push(e))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    ;(DB as any)._indexRetryDelaysMs = [10_000]
    try {
      const building = (DB as any)
        ._buildMarked("mongodb://x", "tenant_r13", fakeDb, "r13_epoch", { indexes: { indexSpecs: [{ key: { a: 1 } }] } })
        .catch(() => {})
      await vi.waitFor(() => expect(release).toBeDefined())
      await DB.disconnect()
      release!()
      await building
      expect(events).toEqual([])
      expect((DB as any)._indexRetryTimers?.size ?? 0).toBe(0)
      expect(calls).toBe(1) // nothing built on the closed client after the disconnect
    } finally {
      await DB.disconnect()
      ;(DB as any)._indexRetryDelaysMs = undefined
      off()
      warn.mockRestore()
    }
  })
})

describe("diffIndexes: review round 13", () => {
  it("lists the indexes and the collection's options together, not one after the other", async () => {
    const { default: DB } = await import("@/db")
    const order: string[] = []
    let collectionsListed!: () => void
    const listed = new Promise<void>((r) => (collectionsListed = r))
    const fakeDb: any = {
      databaseName: "r13_diff",
      collection: () => ({
        listIndexes: () => ({
          toArray: async () => {
            order.push("listIndexes")
            await listed // answered only once the collection listing has been asked for too
            return [{ name: "_id_", key: { _id: 1 } }]
          },
        }),
      }),
      listCollections: () => ({
        toArray: async () => {
          order.push("listCollections")
          collectionsListed()
          return [{ name: "r13_diff_model", options: {} }]
        },
      }),
    }
    const handle = vi.spyOn(DB as any, "_dbHandle").mockReturnValue({ db: fakeDb, dbName: "r13_diff" })
    try {
      const diff = await (DB as any)._diffIndexes("r13_diff_model", "r13_diff")
      expect(order).toEqual(["listIndexes", "listCollections"])
      expect(diff.exists).toBe(true)
    } finally {
      handle.mockRestore()
    }
  })
})

describe("model builds: review round F12", () => {
  // The pair was marked built before the livesIn check: a first use in a database the model did
  // not live in yet (a view's model() before setModelDatabases was set, or before the file
  // declaring it loaded) stayed marked, and once the rule said it lived there nothing was built.
  it("a first use where the model does not live is not remembered: a use after the rule changes builds", async () => {
    const { default: DB } = await import("@/db")
    const built: string[] = []
    const fakeDb: any = {
      databaseName: "tenant_f12",
      listCollections: () => ({ toArray: async () => [] }),
      collection: (name: string) => ({ createIndexes: async () => void built.push(name) }),
    }
    ;(DB as any)._schemas.set("f12_late_home", {})
    try {
      DB.setModelDatabases((model) => (model === "f12_late_home" ? false : null))
      ;(DB as any)._ensureModelApplied("mongodb://x", "tenant_f12", fakeDb, "f12_late_home")
      await new Promise((r) => setTimeout(r, 5))
      expect(built).toEqual([])
      DB.setModelDatabases((model, dbName) => (model === "f12_late_home" ? dbName === "tenant_f12" : null))
      ;(DB as any)._ensureModelApplied("mongodb://x", "tenant_f12", fakeDb, "f12_late_home")
      await new Promise((r) => setTimeout(r, 5))
      expect(built).toContain("f12_late_home")
    } finally {
      DB.setModelDatabases(null)
      ;(DB as any)._schemas.delete("f12_late_home")
      ;(DB as any)._appliedModels.clear()
    }
  })
})

describe("model builds: review round F13", () => {
  // _defineIn (a view's or the singleton's defineModel) still marked the pair before checking
  // livesIn — the bug round F12 fixed in _ensureModelApplied: defined where it did not live yet,
  // the model was never built there once the rule said it did.
  it("a defineModel where the model does not live is not remembered: a use after the rule changes builds", async () => {
    const { default: DB } = await import("@/db")
    const built: string[] = []
    const fakeDb: any = {
      databaseName: "tenant_f13",
      listCollections: () => ({ toArray: async () => [] }),
      collection: (name: string) => ({ createIndexes: async () => void built.push(name) }),
    }
    try {
      DB.setModelDatabases((model) => (model === "f13_late_home" ? false : null))
      await (DB as any)._defineIn("mongodb://x", "tenant_f13", fakeDb, "f13_late_home", undefined, { indexSpecs: [{ key: { a: 1 } }] })
      expect(built).toEqual([])
      DB.setModelDatabases((model, dbName) => (model === "f13_late_home" ? dbName === "tenant_f13" : null))
      ;(DB as any)._ensureModelApplied("mongodb://x", "tenant_f13", fakeDb, "f13_late_home")
      await new Promise((r) => setTimeout(r, 5))
      expect(built).toContain("f13_late_home")
    } finally {
      DB.setModelDatabases(null)
      ;(DB as any)._schemas.delete("f13_late_home")
      ;(DB as any)._appliedModels.clear()
    }
  })
})

describe("diffIndexSpecs: review round F20", () => {
  // Specs were matched in declaration order: one with no exact match took the first index on
  // its key — which could be a later spec's exact match. A unique spec that failed to build took
  // the built partial index as "conflicting", and the partial spec was reported "missing": the
  // reverse of the truth.
  it("matches every spec's exact index first, then pairs what is left", () => {
    const declared: any[] = [
      { key: { email: 1 }, unique: true, name: "email_unique" },
      { key: { email: 1 }, partialFilterExpression: { active: true }, name: "email_partial" },
    ]
    const actual = [id, { key: { email: 1 }, name: "email_partial", partialFilterExpression: { active: true } }]
    const diff = diffIndexSpecs("m", "db", declared, actual)
    expect(diff.missing.map((s) => s.name)).toEqual(["email_unique"])
    expect(diff.conflicting).toEqual([])
  })
})

describe("diffIndexSpecs and specNamedInError: advisor review", () => {
  // Two specs for one index ({ a } and { a, name: "idx_a" }) with idx_a built: the unnamed spec took
  // idx_a in the first pass, and the named one — its own index — was reported missing.
  it("a spec takes the index of its own name first; a duplicate declaration of a built index is not missing", () => {
    const declared: any[] = [{ key: { a: 1 } }, { key: { a: 1 }, name: "idx_a" }]
    const diff = diffIndexSpecs("m", "db", declared, [id, { key: { a: 1 }, name: "idx_a" }])
    expect(diff.missing).toEqual([])
    expect(diff.conflicting).toEqual([])
    expect(diff.undeclared).toEqual([])
  })

  // "Index already exists with a different name: a_1" names the index already there, not the spec
  // refused: an unnamed { a: 1 } spec (generated name a_1) was blamed, and the refused one built.
  it("an error naming the index that already exists blames no spec", async () => {
    const { specNamedInError } = await import("@/db/indexes")
    const err = Object.assign(new Error("Index already exists with a different name: a_1"), { code: 85 })
    expect(specNamedInError(err, [{ key: { a: 1 } }, { key: { a: 1 }, name: "by_a" }] as any)).toBeUndefined()
  })
})

describe("diffIndexSpecs: round F21", () => {
  // A declared text spec matched any text index on the collection, and only its weights were
  // compared: a compound { tenantId: 1, title: "text" } built by hand was reported as the declared
  // { title: "text" } — all well — though the declared index can never be built beside it.
  it("a text spec does not match a text index with other key fields", () => {
    const actual = [id, { key: { tenantId: 1, _fts: "text", _ftsx: 1 }, name: "tenant_text", weights: { title: 1 } }]
    const diff = diffIndexSpecs("m", "db", [{ key: { title: "text" } }], actual)
    expect(diff.missing).toHaveLength(1)
    expect(diff.undeclared.map((i) => i.name)).toEqual(["tenant_text"])
  })
})
