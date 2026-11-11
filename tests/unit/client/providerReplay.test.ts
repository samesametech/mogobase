// The provider gives the client DB each model's MERGED definition, once (review round 18): it
// replayed every raw definition, so a later one without a schema (a file that only opts the model
// into sync) handed the client a timestamps-only schema — its decimal fields gone — while the
// server merged the two (mergeDef keeps the earlier schema).
import { describe, expect, it } from "vitest"
import { defineModel } from "@/runtime/models"
import { v } from "@/server/handlers"
import { defineRegisteredModels } from "@/client/provider"

describe("defineRegisteredModels", () => {
  it("defines each model once, from its merged definition", async () => {
    defineModel("r18_orders", { amount: v.decimal128() })
    defineModel("r18_orders", undefined, { sync: true })
    const calls: { name: string; schema: any }[] = []
    await defineRegisteredModels({ defineModel: async (name: string, schema: any) => void calls.push({ name, schema }) } as any)
    const orders = calls.filter((c) => c.name === "r18_orders")
    expect(orders).toHaveLength(1)
    expect(Object.keys(orders[0].schema.shape ?? orders[0].schema)).toContain("amount")
  })
})
