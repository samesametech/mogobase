// A watch the shared hub cannot evaluate gets a change stream per subscriber. Which input does
// that, why (routeWatchInput's reason), and the one warning that says so.
import { describe, expect, it, vi } from "vitest"
import { routeWatchInput, toServerMatch } from "@/server/watchInput"
import { warnOwnStream } from "@/server/changeStreamWatch"
import { isSupportedFilter, unsupportedOperator } from "@/runtime/filterMatcher"

describe("routeWatchInput: the reason a watch leaves the shared hub (scalability review)", () => {
  it("names the operator or the stage", () => {
    expect(routeWatchInput({ tags: { $elemMatch: { $eq: "x" } } })).toMatchObject({ kind: "pipeline", reason: "operator $elemMatch" })
    expect(routeWatchInput([{ $match: { a: 1 } }, { $project: { a: 1 } }])).toMatchObject({ kind: "pipeline", reason: "stage $project" })
    expect(routeWatchInput([{ $match: { $expr: { $gt: ["$a", 1] } } }])).toMatchObject({ kind: "pipeline", reason: "operator $expr" })
    expect(routeWatchInput({ userId: "u1" })).toMatchObject({ kind: "hub" })
  })

  it("unsupportedOperator agrees with isSupportedFilter", () => {
    for (const f of [{ a: 1 }, { a: { $gt: 1 } }, { $or: [{ a: 1 }, { b: { $elemMatch: {} } }] }, { $where: "x" }, { a: { $size: 2 } }]) {
      expect(isSupportedFilter(f as any)).toBe(unsupportedOperator(f as any) === undefined)
    }
    expect(unsupportedOperator({ $or: [{ a: 1 }, { b: { $elemMatch: {} } }] } as any)).toBe("$elemMatch")
  })
})

describe("warnOwnStream (scalability review)", () => {
  it("warns once per collection and reason, whatever the database, naming the operator", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      for (let i = 0; i < 5; i++) warnOwnStream("db_x", "orders_x", "operator $elemMatch", "live-query watch")
      warnOwnStream("db_x", "orders_x", "stage $project", "live-query watch")
      warnOwnStream("db_y", "orders_x", "operator $elemMatch", "live-query watch") // another tenant's database: not again
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[0][0])).toMatch(/db_x\.orders_x uses operator \$elemMatch.*change stream of its own/)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("a filter for a stream of its own is one MongoDB can run (review round 8)", () => {
  it("a top-level $not becomes $nor, inside $and/$or too", () => {
    expect(toServerMatch({ $not: { a: 1 }, b: 2 })).toEqual({ $nor: [{ a: 1 }], b: 2 })
    expect(toServerMatch({ $or: [{ $not: { a: 1 } }, { c: 3 }] })).toEqual({ $or: [{ $nor: [{ a: 1 }] }, { c: 3 }] })
    expect(toServerMatch({ $not: { a: 1 }, $nor: [{ d: 4 }] })).toEqual({ $nor: [{ a: 1 }, { d: 4 }] })
    expect(toServerMatch({ a: { $not: { $gt: 1 } } })).toEqual({ a: { $not: { $gt: 1 } } }) // a field's $not is MongoDB's own
  })

  it("routeWatchInput sends MongoDB the $nor form", () => {
    const route = routeWatchInput([{ $match: { $not: { "fullDocument.a": 1 }, "fullDocument.tags": { $elemMatch: { $eq: "x" } } } }])
    expect(route).toMatchObject({ kind: "pipeline" })
    expect((route as any).pipeline).toEqual([{ $match: { $nor: [{ "fullDocument.a": 1 }], "fullDocument.tags": { $elemMatch: { $eq: "x" } } } }])
  })
})
