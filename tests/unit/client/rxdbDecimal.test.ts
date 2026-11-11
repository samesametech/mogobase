// RxDB offline: a decimal paginatedField pages by value (review round 18 — round 17 added it with
// a Watermelon test only), and the adapter keeps the decimal fields of the definition that
// created its collection: a second defineModel (React strict mode's double mount, a file that
// only opts the model into sync) rebuilt it from its own schema — none — and paging went back
// to text order.
import "fake-indexeddb/auto"
import { beforeAll, describe, expect, it } from "vitest"
import { v } from "@/server/handlers"

let clientDB: any

beforeAll(async () => {
  clientDB = (await import("@/client/db/rxdb")).default
  await clientDB.connect(`r18_rx_${Date.now()}`)
  await clientDB.defineModel("r18_rx_orders", { amount: v.decimal128() })
  await clientDB.defineModel("r18_rx_orders") // the second definition: no schema
  const orders = clientDB.model("r18_rx_orders")
  for (const amount of ["9.00", "100.00", "12.50", "3.00"]) await orders.insertOne({ amount })
})

describe("RxDB adapter: decimal fields", () => {
  it("keeps the decimal fields of the definition its collection was built from", () => {
    expect([...clientDB.model("r18_rx_orders").decimalFields]).toEqual(["amount"])
  })

  it("the paging polyfill pages a decimal paginatedField by value", async () => {
    const { MongoPaging } = await import("@/runtime/paging")
    const coll = clientDB.model("r18_rx_orders")
    const first = await MongoPaging.find(coll, { paginatedField: "amount", limit: 2, sortAscending: false })
    expect(first.results.map((d: any) => d.amount)).toEqual(["100.00", "12.50"])
    const second = await MongoPaging.find(coll, { paginatedField: "amount", limit: 2, sortAscending: false, next: first.next! })
    expect(second.results.map((d: any) => d.amount)).toEqual(["9.00", "3.00"])
  })
})
