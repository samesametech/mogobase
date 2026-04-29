// tests/unit/runtime/clientFields.test.ts
import { describe, it, expect, beforeEach } from "vitest"
import { defineModel, filterClientFields } from "@/runtime/models"

function resetRegistry() {
  for (const key of Object.keys(globalThis as any)) {
    if (key.includes("mogobase") && key.includes("models")) {
      const slot = (globalThis as any)[key]
      if (slot && typeof slot === "object" && Array.isArray(slot.models)) {
        slot.models.length = 0
      }
    }
  }
}

describe("filterClientFields", () => {
  beforeEach(() => resetRegistry())

  it("returns input unchanged when clientFields is undefined", () => {
    defineModel("widgets")
    const doc = { _id: "1", name: "x", secret: "s" }
    expect(filterClientFields("widgets", doc)).toEqual(doc)
  })

  it("projects single doc to clientFields ∪ engine fields", () => {
    defineModel("widgets", undefined, { clientFields: ["name"] })
    const doc = {
      _id: "1",
      name: "x",
      secret: "should-be-stripped",
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
    }
    const out = filterClientFields("widgets", doc) as any
    expect(out.name).toBe("x")
    expect(out._id).toBe("1")
    expect(out.createdAt).toBe(1)
    expect(out.updatedAt).toBe(2)
    expect(out.deletedAt).toBeNull()
    expect(out.secret).toBeUndefined()
  })

  it("projects array of docs", () => {
    defineModel("widgets", undefined, { clientFields: ["name"] })
    const docs = [
      { _id: "1", name: "a", secret: "s1" },
      { _id: "2", name: "b", secret: "s2" },
    ]
    const out = filterClientFields("widgets", docs) as any[]
    expect(out).toHaveLength(2)
    expect(out[0].secret).toBeUndefined()
    expect(out[0].name).toBe("a")
  })

  it("projects paginated result shape", () => {
    defineModel("widgets", undefined, { clientFields: ["name"] })
    const paged = {
      results: [{ _id: "1", name: "a", secret: "s" }],
      hasNext: true,
      hasPrevious: false,
      next: "cursor",
      previous: undefined,
    }
    const out = filterClientFields("widgets", paged) as any
    expect(out.hasNext).toBe(true)
    expect(out.hasPrevious).toBe(false)
    expect(out.next).toBe("cursor")
    expect(out.results[0].secret).toBeUndefined()
    expect(out.results[0].name).toBe("a")
  })

  it("returns input unchanged for unknown model", () => {
    const doc = { _id: "1", anything: "goes" }
    expect(filterClientFields("nope", doc)).toEqual(doc)
  })
})
