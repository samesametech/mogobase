// The offline WatermelonDB adapter answers an isomorphic handler's filter as the server does for
// a v.decimal128() field: stored offline as its decimal string, compared with a number by value
// (review round 15 — round 14's type bracketing made it miss those rows) — and ONLY for those
// fields (review round 16: every digit string had compared with numbers, so { zip: 2134 } found
// "02134" offline, and updateOne / deleteMany hit rows the server would not). It sorts them by
// value too: as text, "9.00" was the largest of 9, 10 and 100.
import "fake-indexeddb/auto"
import { beforeAll, describe, expect, it } from "vitest"
import { v } from "@/server/handlers"

let clientDB: any

beforeAll(async () => {
  clientDB = (await import("@/client/db/watermelon")).default
  await clientDB.connect(`r15_decimal_${Date.now()}`)
  await clientDB.defineModel("r15_invoices", { amount: v.decimal128(), zip: v.string() })
  const invoices = clientDB.model("r15_invoices")
  await invoices.insertOne({ amount: "12.50", zip: "02134" })
  await invoices.insertOne({ amount: "3.00", zip: "10001" })
  await invoices.insertOne({ amount: "100.00", zip: "94105" })
  await invoices.insertOne({ amount: "9.00", zip: "60601" })
})

describe("WatermelonDB adapter: decimal fields", () => {
  it("{ amount: { $gt: 10 } } finds the rows holding \"12.50\" and \"100.00\"", async () => {
    const found = await clientDB.model("r15_invoices").find({ amount: { $gt: 10 } }).toArray()
    expect(found.map((d: any) => d.amount).sort()).toEqual(["100.00", "12.50"])
  })

  it("a string field is not a number: { zip: 2134 } does not find \"02134\" (MongoDB's answer)", async () => {
    expect(await clientDB.model("r15_invoices").find({ zip: 2134 }).toArray()).toEqual([])
    expect(await clientDB.model("r15_invoices").find({ zip: { $gt: 0 } }).toArray()).toEqual([])
  })

  it("sorts a decimal field by value", async () => {
    const top = await clientDB.model("r15_invoices").find({}).sort({ amount: -1 }).limit(2).toArray()
    expect(top.map((d: any) => d.amount)).toEqual(["100.00", "12.50"])
  })
})

describe("the offline paging polyfill over a decimal field (review round 17)", () => {
  // MongoPaging (the polyfill offline paginated handlers use) ordered and paged by text: "9.00"
  // came before "100.00" descending, disagreeing with the server's Decimal128 order and with
  // the adapter's own .sort().
  it("pages a decimal paginatedField by value, cursors included", async () => {
    const { MongoPaging } = await import("@/runtime/paging")
    const coll = clientDB.model("r15_invoices")
    const first = await MongoPaging.find(coll, { paginatedField: "amount", limit: 2, sortAscending: false })
    expect(first.results.map((d: any) => d.amount)).toEqual(["100.00", "12.50"])
    const second = await MongoPaging.find(coll, { paginatedField: "amount", limit: 2, sortAscending: false, next: first.next! })
    expect(second.results.map((d: any) => d.amount)).toEqual(["9.00", "3.00"])
  })

  it("a collection that declares no decimal fields pages as before (text)", async () => {
    const { MongoPaging } = await import("@/runtime/paging")
    const plain = { find: () => ({ toArray: async () => [{ _id: "a", v: "9.00" }, { _id: "b", v: "100.00" }] }) }
    const rs = await MongoPaging.find(plain, { paginatedField: "v", limit: 2, sortAscending: false })
    expect(rs.results.map((d: any) => d.v)).toEqual(["9.00", "100.00"])
  })
})
