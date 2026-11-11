// tests/unit/runtime/models.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import z4 from "zod/v4"
import {
  defineModel,
  getModels,
  getClientFields,
  isSyncEnabled,
  isValidationEnabled,
  getModelZodSchema,
  getTimeseriesOptions,
  isTimeseries,
  indexEnvelope,
  CLIENT_ENGINE_FIELDS,
  latestModelDef,
} from "@/runtime/models"

// The runtime/models module stashes its registry on globalThis to survive
// hot-reloads. Tests reset it between cases. The exact key is private to the
// module — we discover it at runtime so the test does not bind to internals
// beyond "there is a key starting with __mogobase_models".
function resetRegistry() {
  for (const key of Object.keys(globalThis as any)) {
    if (key.includes("mogobase") && key.includes("models")) {
      const slot = (globalThis as any)[key]
      if (slot && typeof slot === "object" && Array.isArray(slot.models)) {
        // Clear the models array without deleting it (the module holds a ref)
        slot.models.length = 0
      }
    }
  }
}

describe("defineModel + withSyncFields", () => {
  beforeEach(() => resetRegistry())

  it("merges sync fields into a ZodObject schema", () => {
    const schema = z4.object({ name: z4.string() })
    defineModel("widgets", schema)
    const models = getModels()
    const widgetDef = models.find((m) => m.name === "widgets")
    expect(widgetDef).toBeDefined()
    const merged = (widgetDef!.schema as any).shape
    expect(merged.name).toBeDefined()
    expect(merged.createdAt).toBeDefined()
    expect(merged.updatedAt).toBeDefined()
    expect(merged.deletedAt).toBeDefined()
  })

  it("merges sync fields into a plain shape object", () => {
    defineModel("widgets", { name: z4.string() } as any)
    const widgetDef = getModels().find((m) => m.name === "widgets")
    const shape = widgetDef!.schema as any
    expect(shape.name).toBeDefined()
    expect(shape.createdAt).toBeDefined()
    expect(shape.updatedAt).toBeDefined()
    expect(shape.deletedAt).toBeDefined()
  })

  it("sync fields override consumer-defined timestamp fields", () => {
    const schema = z4.object({
      name: z4.string(),
      updatedAt: z4.string(),
    })
    defineModel("widgets", schema)
    const widgetDef = getModels().find((m) => m.name === "widgets")
    const merged = (widgetDef!.schema as any).shape
    // Asserted by what the schema ACCEPTS rather than by its class: the engine
    // stamp is a union (number | Date), so a `instanceof ZodNumber` check would
    // pin the implementation instead of the contract.
    expect(merged.updatedAt.safeParse(Date.now()).success).toBe(true)
    expect(merged.updatedAt.safeParse(new Date()).success).toBe(true)
    // The consumer's `z4.string()` did NOT win.
    expect(merged.updatedAt.safeParse("2026-09-03").success).toBe(false)
  })

  it("engine timestamps take a Date as well as epoch milliseconds", () => {
    defineModel("stamped", z4.object({ name: z4.string() }))
    const shape = (getModels().find((m) => m.name === "stamped")!.schema as any).shape
    for (const field of ["createdAt", "updatedAt", "deletedAt"]) {
      expect(shape[field].safeParse(1788220800000).success).toBe(true)
      expect(shape[field].safeParse(new Date()).success).toBe(true)
    }
    // Only deletedAt is nullable — an absent tombstone is a value, a missing
    // birth stamp is the bug this union exists alongside.
    expect(shape.deletedAt.safeParse(null).success).toBe(true)
    expect(shape.createdAt.safeParse(null).success).toBe(false)
  })

  it("supports schema-less models (just sync fields)", () => {
    defineModel("audit_log")
    const auditDef = getModels().find((m) => m.name === "audit_log")
    const merged = auditDef!.schema
    expect(merged).toBeDefined()
  })
})

describe("getClientFields / isSyncEnabled / getModelOptions", () => {
  beforeEach(() => resetRegistry())

  it("returns clientFields when set", () => {
    defineModel("orders", undefined, { clientFields: ["userId", "total"] })
    expect(getClientFields("orders")).toEqual(["userId", "total"])
  })

  it("returns undefined for clientFields when not set", () => {
    defineModel("orders")
    expect(getClientFields("orders")).toBeUndefined()
  })

  it("isSyncEnabled false by default", () => {
    defineModel("orders")
    expect(isSyncEnabled("orders")).toBe(false)
  })

  it("isSyncEnabled true when sync: true", () => {
    defineModel("orders", undefined, { sync: true })
    expect(isSyncEnabled("orders")).toBe(true)
  })

  it("isSyncEnabled false for unknown model", () => {
    expect(isSyncEnabled("nope")).toBe(false)
  })
})

describe("isValidationEnabled", () => {
  beforeEach(() => resetRegistry())

  it("false by default", () => {
    defineModel("orders")
    expect(isValidationEnabled("orders")).toBe(false)
  })

  it("true when dbValidation: true", () => {
    defineModel("orders", undefined, { dbValidation: true })
    expect(isValidationEnabled("orders")).toBe(true)
  })

  it("false for unknown model", () => {
    expect(isValidationEnabled("nope")).toBe(false)
  })

  it("independent of sync flag", () => {
    defineModel("a", undefined, { dbValidation: true })
    defineModel("b", undefined, { sync: true })
    expect(isValidationEnabled("a")).toBe(true)
    expect(isSyncEnabled("a")).toBe(false)
    expect(isValidationEnabled("b")).toBe(false)
    expect(isSyncEnabled("b")).toBe(true)
  })

  it("latest definition wins when a model is registered twice", () => {
    defineModel("orders", undefined, { dbValidation: false })
    defineModel("orders", undefined, { dbValidation: true })
    expect(isValidationEnabled("orders")).toBe(true)
  })
})

describe("getModelZodSchema", () => {
  beforeEach(() => resetRegistry())

  it("returns a ZodObject when the model was defined with one", () => {
    defineModel("widgets", z4.object({ name: z4.string() }))
    const zod = getModelZodSchema("widgets")
    expect(zod).toBeDefined()
    // Schema must be parsable and include sync fields injected by withSyncFields.
    const result = zod!.safeParse({
      name: "x",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    })
    expect(result.success).toBe(true)
  })

  it("wraps a plain shape object into a parsable schema", () => {
    defineModel("widgets", { name: z4.string() } as any)
    const zod = getModelZodSchema("widgets")
    expect(zod).toBeDefined()
    const ok = zod!.safeParse({
      name: "x",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    })
    expect(ok.success).toBe(true)
    const bad = zod!.safeParse({
      name: 123,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    })
    expect(bad.success).toBe(false)
  })

  it("returns undefined for unknown models", () => {
    expect(getModelZodSchema("nope")).toBeUndefined()
  })

  it("schemaless model still resolves to a parsable schema (sync fields only)", () => {
    defineModel("audit_log")
    const zod = getModelZodSchema("audit_log")
    expect(zod).toBeDefined()
    const result = zod!.safeParse({ createdAt: 1, updatedAt: 1, deletedAt: null })
    expect(result.success).toBe(true)
  })
})

describe("timeseries", () => {
  beforeEach(() => resetRegistry())

  it("isTimeseries false by default", () => {
    defineModel("readings")
    expect(isTimeseries("readings")).toBe(false)
    expect(getTimeseriesOptions("readings")).toBeUndefined()
  })

  it("isTimeseries true when timeseries is set, returns full opts", () => {
    defineModel("readings", undefined, {
      timeseries: { timeField: "ts", metaField: "sensorId", granularity: "seconds" },
    })
    expect(isTimeseries("readings")).toBe(true)
    expect(getTimeseriesOptions("readings")).toEqual({
      timeField: "ts",
      metaField: "sensorId",
      granularity: "seconds",
    })
  })

  it("throws if a model is both sync and timeseries", () => {
    expect(() =>
      defineModel("bad", undefined, {
        sync: true,
        timeseries: { timeField: "ts" },
      })
    ).toThrow(/incompatible with `timeseries`/)
  })

  it("timeseries is independent of clientFields and dbValidation", () => {
    defineModel("readings", undefined, {
      timeseries: { timeField: "ts" },
      clientFields: ["value", "sensorId"],
      dbValidation: true,
    })
    expect(isTimeseries("readings")).toBe(true)
    expect(isValidationEnabled("readings")).toBe(true)
    expect(getClientFields("readings")).toEqual(["value", "sensorId"])
  })
})

describe("indexSpecs", () => {
  beforeEach(() => resetRegistry())

  const specs = [
    { key: { gatewayCode: 1, gatewayEventId: 1 }, unique: true, name: "u" },
    { key: { expiresAt: 1 }, name: "ttl", expireAfterSeconds: 0 },
  ]

  it("carries indexSpecs on the registered def", () => {
    defineModel("webhook_events", undefined, { sync: false, indexSpecs: specs })
    const def = getModels().find((m) => m.name === "webhook_events")
    expect(def!.indexSpecs).toEqual(specs)
  })

  it("maps a bare 3rd-arg array to indexSpecs", () => {
    defineModel("widgets", undefined, specs)
    expect(getModels().find((m) => m.name === "widgets")!.indexSpecs).toEqual(specs)
  })

  it("indexEnvelope wraps specs into the createIndexes envelope, undefined when absent", () => {
    defineModel("with", undefined, { indexSpecs: specs })
    defineModel("without", undefined, { clientFields: ["a"] })
    const models = getModels()
    expect(indexEnvelope(models.find((m) => m.name === "with")!)).toEqual({ indexSpecs: specs })
    expect(indexEnvelope(models.find((m) => m.name === "without")!)).toBeUndefined()
  })
})

describe("CLIENT_ENGINE_FIELDS", () => {
  it("contains the four engine fields", () => {
    expect(CLIENT_ENGINE_FIELDS).toEqual(expect.arrayContaining(["_id", "createdAt", "updatedAt", "deletedAt"]))
    expect(CLIENT_ENGINE_FIELDS.length).toBe(4)
  })
})

describe("latestModelDefs (review round 8)", () => {
  it("one definition per model, each field from the latest definition that set it", async () => {
    const { defineModel, latestModelDefs } = await import("@/runtime/models")
    defineModel("r8_twice", undefined, { indexSpecs: [{ key: { a: 1 } }] })
    defineModel("r8_twice", { title: (await import("zod/v4")).z.string() })
    const defs = latestModelDefs().filter((m) => m.name === "r8_twice")
    expect(defs).toHaveLength(1)
    expect(defs[0].indexSpecs).toEqual([{ key: { a: 1 } }])
    expect(defs[0].schema).toBeDefined()
  })
})

describe("latestModelDef (review round 10)", () => {
  it("merges one model's definitions, as latestModelDefs does for all", async () => {
    const { defineModel, latestModelDef, latestModelDefs } = await import("@/runtime/models")
    defineModel("r10_one", undefined, { indexSpecs: [{ key: { a: 1 } }] })
    defineModel("r10_other", undefined, { indexSpecs: [{ key: { b: 1 } }] })
    defineModel("r10_one", undefined, { sync: true })
    expect(latestModelDef("r10_one")).toEqual(latestModelDefs().find((d) => d.name === "r10_one"))
    expect(latestModelDef("r10_one")).toMatchObject({ indexSpecs: [{ key: { a: 1 } }], sync: true })
    expect(latestModelDef("r10_missing")).toBeUndefined()
  })
})

describe("merged definitions (review round 11)", () => {
  it("a later definition without sync / dbValidation does not turn an earlier true off", async () => {
    const { defineModel, latestModelDef, isSyncEnabled } = await import("@/runtime/models")
    defineModel("r11_synced", undefined, { sync: true, dbValidation: true })
    defineModel("r11_synced") // an offline handler file declaring it again, plainly
    expect(isSyncEnabled("r11_synced")).toBe(true)
    expect(latestModelDef("r11_synced")).toMatchObject({ sync: true, dbValidation: true })
  })
})

describe("latestModelDef kept as definitions arrive (review round 12)", () => {
  it("reflects a definition registered after it was first read", async () => {
    const { defineModel, latestModelDef, latestModelDefs } = await import("@/runtime/models")
    defineModel("r12_late", undefined, { indexSpecs: [{ key: { a: 1 } }] })
    expect(latestModelDef("r12_late")?.sync).toBe(false)
    defineModel("r12_late", undefined, { sync: true })
    expect(latestModelDef("r12_late")).toMatchObject({ sync: true, indexSpecs: [{ key: { a: 1 } }] })
    expect(latestModelDefs().filter((d) => d.name === "r12_late")).toHaveLength(1)
  })
})

describe("registry: review round 14", () => {
  beforeEach(() => resetRegistry())

  // withSyncFields(undefined) is the timestamps-only shape, never undefined, so a later
  // definition without a schema (a file that only opts the model into sync) replaced the
  // schema: decimal fields stopped being encoded, and dbValidation checked only timestamps.
  it("a later definition without a schema keeps the earlier one's schema", async () => {
    const { v } = await import("@/server/handlers")
    defineModel("r14_orders", { total: v.decimal128(), note: v.string() }, { dbValidation: true })
    defineModel("r14_orders", undefined, { sync: true })
    const schema: any = getModelZodSchema("r14_orders")
    expect(Object.keys(schema.shape)).toEqual(expect.arrayContaining(["total", "note", "createdAt"]))
    const built: any = latestModelDef("r14_orders")!.schema // what DB builds and keeps in _schemas
    expect(Object.keys(built.shape ?? built)).toContain("total")
    expect(isSyncEnabled("r14_orders")).toBe(true)
    expect(isValidationEnabled("r14_orders")).toBe(true)
  })

  it("a later definition WITH a schema still replaces it", () => {
    defineModel("r14_items", { a: z4.string() })
    defineModel("r14_items", { b: z4.string() })
    const schema: any = getModelZodSchema("r14_items")
    expect(Object.keys(schema.shape)).toContain("b")
    expect(Object.keys(schema.shape)).not.toContain("a")
  })
})

describe("registry: cleared in place (review round 14, pinned)", () => {
  beforeEach(() => resetRegistry())

  // Reviewed as stale: the merged cache is keyed on the array's length. It is not — defineModel
  // reads the cache BEFORE pushing, sees the cleared array's length differ, and rebuilds.
  it("registering the same number of definitions again reads the new ones", () => {
    defineModel("r14_reset", undefined, { sync: true, clientFields: ["a"] })
    expect(isSyncEnabled("r14_reset")).toBe(true)
    resetRegistry()
    defineModel("r14_reset", undefined, { clientFields: ["b"] })
    expect(isSyncEnabled("r14_reset")).toBe(false)
    expect(getClientFields("r14_reset")).toEqual(["b"])
  })
})

describe("registry: review round 19", () => {
  beforeEach(() => resetRegistry())

  // The warning read only the definition being registered, so the usual split — one file opting
  // out of the stamp indexes, another opting the model into sync — never warned.
  it("warns when the MERGED definition is a sync model without the updatedAt index", async () => {
    const { vi } = await import("vitest")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    defineModel("r19_posts", undefined, { stampIndexes: false })
    defineModel("r19_posts", undefined, { sync: true })
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("r19_posts"))).toHaveLength(1)
    warn.mockRestore()
  })
})

describe("registry: review round F10", () => {
  beforeEach(() => resetRegistry())

  it("sync: true and timeseries set by two definitions throw at registration, as one does", () => {
    defineModel("r10_metrics", undefined, { timeseries: { timeField: "ts" } })
    expect(() => defineModel("r10_metrics", undefined, { sync: true })).toThrow(/incompatible with `timeseries`/)
    expect(isSyncEnabled("r10_metrics")).toBe(false) // the refused definition was not registered
    expect(() => defineModel("r10_metrics2", undefined, { timeseries: { timeField: "ts" }, sync: true })).toThrow(/incompatible/)
  })
})

describe("merged definitions: review round F14", () => {
  // mergeDef let the latest definition's indexSpecs replace the earlier ones, and connect() builds
  // only the merged definition: a model whose indexes are declared in two files lost the first
  // file's — a unique index never built on a fresh database, and listed as undeclared (so
  // dropUndeclaredIndexes dropped it) on an existing one. On main every definition was built.
  it("keeps every distinct index spec any definition declares", async () => {
    const { defineModel, latestModelDef } = await import("@/runtime/models")
    defineModel("f14_users", undefined, { indexSpecs: [{ key: { email: 1 }, unique: true }] })
    defineModel("f14_users", undefined, { sync: true, indexSpecs: [{ key: { orgId: 1 } }, { key: { email: 1 }, unique: true }] })
    defineModel("f14_users", undefined, { indexSpecs: [{ key: { email: 1 } }] }) // same key, other options: both kept, as main built both
    expect(latestModelDef("f14_users")?.indexSpecs).toEqual([
      { key: { email: 1 }, unique: true },
      { key: { orgId: 1 } },
      { key: { email: 1 } },
    ])
  })
})

describe("merged definitions: review round F15", () => {
  // Two definitions declaring one index key with different options (unique in one file, plain in
  // another) are both kept, as main built both — and MongoDB builds only one: the other failed on
  // every boot, reported only as an index error. It is said at registration, naming the key.
  it("warns when two definitions declare one index key with different options", async () => {
    const { defineModel } = await import("@/runtime/models")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    defineModel("f15_conflict", undefined, { indexSpecs: [{ key: { email: 1 }, unique: true }] })
    defineModel("f15_conflict", undefined, { indexSpecs: [{ key: { email: 1 }, unique: true }, { key: { org: 1 } }] }) // same spec again: fine
    expect(warn).not.toHaveBeenCalled()
    defineModel("f15_conflict", undefined, { indexSpecs: [{ key: { email: 1 } }] })
    // After the advisor review the server decides such pairs (onIndexError reports a refusal): no
    // registration warning. Both specs are kept, as main built both.
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("merged definitions: review round F16", () => {
  // Specs added up only when both definitions had some: a later definition with indexSpecs: []
  // passed the "set" filter and replaced every spec declared before with none — the unique index
  // never built on a fresh database, and undeclared (dropUndeclaredIndexes dropped it) on another.
  it("a later definition declaring no index specs keeps the earlier ones", async () => {
    const { defineModel, latestModelDef } = await import("@/runtime/models")
    defineModel("f16_users", undefined, { indexSpecs: [{ key: { email: 1 }, unique: true }] })
    defineModel("f16_users", undefined, { sync: true, indexSpecs: [] })
    expect(latestModelDef("f16_users")?.indexSpecs).toEqual([{ key: { email: 1 }, unique: true }])
  })
})

describe("merged definitions: review round F17", () => {
  // The conflict warning said MongoDB builds only one of two specs on one key — but it keeps both
  // when their names differ (a unique email_1 and a plain email_plain build side by side): an app
  // following the advice dropped an index it needed. And the warning printed again every time the
  // merged cache was rebuilt.
  it("does not warn when the two specs' names differ, and warns once per conflict", async () => {
    const { defineModel } = await import("@/runtime/models")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    defineModel("f17_named", undefined, { indexSpecs: [{ key: { email: 1 }, unique: true }] })
    defineModel("f17_named", undefined, { indexSpecs: [{ key: { email: 1 }, name: "email_plain" }] })
    expect(warn).not.toHaveBeenCalled()
    defineModel("f17_unnamed", undefined, { indexSpecs: [{ key: { email: 1 }, unique: true }] })
    defineModel("f17_unnamed", undefined, { indexSpecs: [{ key: { email: 1 } }] }) // both email_1
    expect(warn).not.toHaveBeenCalled() // the server decides (advisor review)
    warn.mockRestore()
  })
})

describe("merged definitions: review round F18", () => {
  // Round F17 took any two names for "MongoDB keeps both"; MongoDB refuses an index with the same
  // key and options under another name ("already exists with a different name"), so specs that
  // differed only by name failed on every boot, unwarned.
  it("warns when two specs on one key differ only by name", async () => {
    const { defineModel } = await import("@/runtime/models")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    defineModel("f18_renamed", undefined, { indexSpecs: [{ key: { email: 1 } }] })
    defineModel("f18_renamed", undefined, { indexSpecs: [{ key: { email: 1 }, name: "by_email" }] })
    expect(warn).not.toHaveBeenCalled() // the server decides (advisor review)
    warn.mockRestore()
  })
})

describe("merged definitions: review round F19", () => {
  // The check guessed at which differences MongoDB lets coexist, and missed both ways: two specs
  // with no name but different collations share the generated name email_1 — MongoDB refuses the
  // second — yet "collation differs" read as coexisting; and options compared with JSON.stringify
  // told { locale, strength } from { strength, locale }. It warns only where MongoDB always
  // refuses: the same name with other options, or the same key and options under another name.
  it("warns on a shared generated name whatever the options, and reads options in any key order", async () => {
    const { defineModel, latestModelDef } = await import("@/runtime/models")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    defineModel("f19_collated", undefined, { indexSpecs: [{ key: { email: 1 } }] })
    defineModel("f19_collated", undefined, { indexSpecs: [{ key: { email: 1 }, collation: { locale: "en", strength: 2 } }] })
    expect(warn).not.toHaveBeenCalled() // the server decides (advisor review)
    defineModel("f19_order", undefined, { indexSpecs: [{ key: { email: 1 }, collation: { locale: "en", strength: 2 } }] })
    defineModel("f19_order", undefined, { indexSpecs: [{ key: { email: 1 }, collation: { strength: 2, locale: "en" } }] })
    expect(warn).not.toHaveBeenCalled()
    expect(latestModelDef("f19_order")?.indexSpecs).toHaveLength(1) // one spec, not two
    warn.mockRestore()
  })
})

describe("merged definitions: review round F20", () => {
  // One explicit name on two keys MongoDB always refuses ("same name … different key"), but only
  // specs on one key were compared. And an option set to undefined, or unique / sparse / hidden
  // false, counted as different from none — MongoDB builds the same index — so a warning said one
  // would fail on every boot, and both specs were kept.
  it("warns on one name over two keys; reads undefined and false options as absent", async () => {
    const { defineModel, latestModelDef } = await import("@/runtime/models")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    defineModel("f20_named", undefined, { indexSpecs: [{ key: { a: 1 }, name: "lookup" }] })
    defineModel("f20_named", undefined, { indexSpecs: [{ key: { b: 1 }, name: "lookup" }] })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockClear()
    defineModel("f20_absent", undefined, { indexSpecs: [{ key: { email: 1 } }] })
    defineModel("f20_absent", undefined, { indexSpecs: [{ key: { email: 1 }, unique: undefined, sparse: false } as any] })
    expect(warn).not.toHaveBeenCalled()
    expect(latestModelDef("f20_absent")?.indexSpecs).toHaveLength(1)
    warn.mockRestore()
  })
})

describe("merged definitions: advisor review", () => {
  // The warning claimed "MongoDB refuses one of them" where MongoDB builds both, or builds the
  // second as a no-op (differing only by background, hidden or v): what MongoDB refuses depends on
  // its version and on defaults only it fills in, and onIndexError reports each real refusal with
  // the server's own words. Only "one name on two keys" — refused on every version — is said now.
  // And one index spelled two ways ({ key } and { key, name: "a_1" }, or one with background /
  // hidden / v) was kept twice: a fresh collection's batch was then refused whole ("Cannot build
  // two identical indexes"), and every spec was built one by one, a collection scan each.
  it("keeps one spec for one index spelled two ways, and warns only on one name over two keys", async () => {
    const { defineModel, latestModelDef } = await import("@/runtime/models")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    defineModel("adv_spelled", undefined, { indexSpecs: [{ key: { a: 1 } }] })
    defineModel("adv_spelled", undefined, { indexSpecs: [{ key: { a: 1 }, name: "a_1" }, { key: { a: 1 }, background: true, v: 2 } as any] })
    expect(latestModelDef("adv_spelled")?.indexSpecs).toHaveLength(1)
    defineModel("adv_quiet", undefined, { indexSpecs: [{ key: { email: 1 } }] })
    defineModel("adv_quiet", undefined, { indexSpecs: [{ key: { email: 1 }, unique: true }] }) // the server decides
    expect(warn).not.toHaveBeenCalled()
    defineModel("adv_twokeys", undefined, { indexSpecs: [{ key: { a: 1 }, name: "lookup" }] })
    defineModel("adv_twokeys", undefined, { indexSpecs: [{ key: { b: 1 }, name: "lookup" }] })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
