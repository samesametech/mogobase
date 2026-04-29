// tests/unit/runtime/models.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import z4 from "zod/v4"
import {
  defineModel,
  getModels,
  getClientFields,
  isSyncEnabled,
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

describe("CLIENT_ENGINE_FIELDS", () => {
  it("contains the four engine fields", () => {
    expect(CLIENT_ENGINE_FIELDS).toEqual(expect.arrayContaining(["_id", "createdAt", "updatedAt", "deletedAt"]))
    expect(CLIENT_ENGINE_FIELDS.length).toBe(4)
  })
})
