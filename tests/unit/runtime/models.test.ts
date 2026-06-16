// tests/unit/runtime/models.test.ts
import { describe, it, expect, beforeEach } from "vitest"
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
    // Should be a number-typed schema, not the consumer's string.
    // In Zod v4, ZodNumber has _def.type === "number".
    const isNumberSchema =
      merged.updatedAt instanceof z4.ZodNumber ||
      merged.updatedAt._def?.type === "number" ||
      merged.updatedAt._def?.typeName === "ZodNumber" ||
      merged.updatedAt.constructor.name.toLowerCase().includes("number")
    expect(isNumberSchema).toBe(true)
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
