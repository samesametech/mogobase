// tests/unit/runtime/paging.test.ts
import { describe, it, expect } from "vitest"
import { MongoPaging } from "@/runtime/paging"

// Build a tiny in-memory collection that exposes find().toArray() — that's
// the only interface MongoPaging.find depends on per the runtime/paging
// polyfill contract.
function makeCollection(rows: any[]) {
  return {
    find(filter: any = {}) {
      const matched = rows.filter((r) => {
        for (const [k, v] of Object.entries(filter)) {
          if (r[k] !== v) return false
        }
        return true
      })
      return {
        toArray: async () => matched,
      }
    },
  }
}

describe("MongoPaging.find", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    _id: String(i + 1).padStart(3, "0"),
    name: `n${i}`,
    score: i,
  }))

  // NOTE: default sortAscending is false (descending), so "025" comes first.
  it("paginates by _id descending (default)", async () => {
    const col = makeCollection(rows)
    const page = await MongoPaging.find(col as any, { limit: 10 })
    expect(page.results).toHaveLength(10)
    expect(page.results[0]._id).toBe("025")
    expect(page.results[9]._id).toBe("016")
    expect(page.hasNext).toBe(true)
    expect(page.hasPrevious).toBe(false)
    expect(page.next).toBeDefined()
    expect(page.next).not.toBeNull()
  })

  it("paginates by _id ascending when sortAscending=true", async () => {
    const col = makeCollection(rows)
    const page = await MongoPaging.find(col as any, { limit: 10, sortAscending: true })
    expect(page.results).toHaveLength(10)
    expect(page.results[0]._id).toBe("001")
    expect(page.results[9]._id).toBe("010")
    expect(page.hasNext).toBe(true)
    expect(page.hasPrevious).toBe(false)
    expect(page.next).toBeDefined()
  })

  it("walks next page using returned cursor", async () => {
    const col = makeCollection(rows)
    const first = await MongoPaging.find(col as any, { limit: 10, sortAscending: true })
    const second = await MongoPaging.find(col as any, { limit: 10, sortAscending: true, next: first.next! })
    expect(second.results).toHaveLength(10)
    expect(second.results[0]._id).toBe("011")
    expect(second.results[9]._id).toBe("020")
    expect(second.hasPrevious).toBe(true)
    expect(second.hasNext).toBe(true)
  })

  it("walks previous page using returned cursor", async () => {
    const col = makeCollection(rows)
    const first = await MongoPaging.find(col as any, { limit: 10, sortAscending: true })
    const second = await MongoPaging.find(col as any, { limit: 10, sortAscending: true, next: first.next! })
    const back = await MongoPaging.find(col as any, { limit: 10, sortAscending: true, previous: second.previous! })
    expect(back.results).toHaveLength(10)
    expect(back.results[0]._id).toBe("001")
  })

  it("supports paginatedField with descending sort", async () => {
    const col = makeCollection(rows)
    const page = await MongoPaging.find(col as any, {
      limit: 5,
      paginatedField: "score",
      sortAscending: false,
    })
    expect(page.results.map((r: any) => r.score)).toEqual([24, 23, 22, 21, 20])
  })

  it("respects fields projection", async () => {
    const col = makeCollection(rows.slice(0, 3))
    const page = await MongoPaging.find(col as any, {
      limit: 10,
      fields: { _id: 1, name: 1 },
    })
    for (const r of page.results) {
      expect(r._id).toBeDefined()
      expect(r.name).toBeDefined()
      expect((r as any).score).toBeUndefined()
    }
  })

  // NOTE: even on the last page, next is a cursor for the last item (not null/undefined).
  // hasNext=false is the signal that there are no more results; the cursor is still emitted.
  it("hasNext=false on last page", async () => {
    const col = makeCollection(rows.slice(0, 3))
    const page = await MongoPaging.find(col as any, { limit: 10 })
    expect(page.results).toHaveLength(3)
    expect(page.hasNext).toBe(false)
    // Cursor is still present (position marker for next page) — polyfill always emits
    // a cursor when there are results; callers rely on hasNext to decide whether to fetch.
    expect(page.next).toBeDefined()
  })

  it("supports dotted-path paginatedField", async () => {
    const nested = [
      { _id: "1", meta: { score: 30 } },
      { _id: "2", meta: { score: 10 } },
      { _id: "3", meta: { score: 20 } },
    ]
    const col = makeCollection(nested)
    const page = await MongoPaging.find(col as any, {
      limit: 10,
      paginatedField: "meta.score",
      sortAscending: true,
    })
    expect(page.results.map((r: any) => r.meta.score)).toEqual([10, 20, 30])
  })
})
