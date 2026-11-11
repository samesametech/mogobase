// The reads a pull makes sort on one field each, which a single-field stamp index can serve
// (review round F17): sorted on { updatedAt, _id } (round F16) or { updatedAt, createdAt } (main),
// MongoDB sorted every matching row in memory — a whole collection on a first pull.
import { afterEach, describe, expect, it, vi } from "vitest"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { pullChanges } from "@/server/sync"

defineModel("f17_pull_reads", undefined, { sync: true })

afterEach(() => vi.restoreAllMocks())

describe("pullChanges reads (review round F17)", () => {
  it("each read sorts on one field", async () => {
    const sorts: unknown[] = []
    const cursor = () => {
      const c: any = { project: () => c, sort: (s: unknown) => (sorts.push(s), c), limit: () => c, toArray: async () => [] }
      return c
    }
    vi.spyOn(DB, "connect").mockResolvedValue(DB as any)
    vi.spyOn(DB, "model").mockReturnValue({ find: cursor, findOne: async () => null } as any)
    await pullChanges({ model: "f17_pull_reads", checkpoint: 1000 })
    expect(sorts.length).toBeGreaterThan(0)
    for (const sort of sorts) expect(Object.keys(sort as object)).toHaveLength(1)
  })
})

describe("pullChanges reads (review rounds F19, F20)", () => {
  // Round F18 read every row whose updatedAt is not a number, unbounded, into Node (F19: a million
  // unstamped rows loaded per pull); round F19 read them through an aggregation, whose $match
  // refuses a policy filter's $where or $near (every pull of such a policy failed) and which scanned
  // the collection on every pull. A pull makes index-range finds only, each limited to a batch.
  it("reads with finds only, each sorted on one field and limited to a batch", async () => {
    const limits: number[] = []
    const cursor = () => {
      const c: any = { project: () => c, sort: () => c, limit: (n: number) => (limits.push(n), c), toArray: async () => [] }
      return c
    }
    const aggregate = vi.fn()
    vi.spyOn(DB, "connect").mockResolvedValue(DB as any)
    vi.spyOn(DB, "model").mockReturnValue({ find: cursor, aggregate, findOne: async () => null } as any)
    await pullChanges({ model: "f17_pull_reads", checkpoint: 1000, batchSize: 50 })
    expect(aggregate).not.toHaveBeenCalled()
    expect(limits.length).toBeGreaterThan(0)
    expect(limits.every((n) => n === 50)).toBe(true)
  })
})

describe("pullChanges: a large tie group (advisor review)", () => {
  // The rest of a group was appended with docs.push(...rows): past about 100 000 rows (a soft
  // deleteMany of that many) the spread overflowed the call stack, and every pull of that model
  // threw for good. Main answered a batch and moved on.
  it("answers a group of 600 000 rows sharing one updatedAt without overflowing the stack", async () => {
    const T = 1_700_000_000_000
    const batch = Array.from({ length: 200 }, (_, i) => ({ _id: `b${i}`, updatedAt: T }))
    const rest = Array.from({ length: 600_000 }, (_, i) => ({ _id: `r${i}`, updatedAt: T }))
    let call = 0
    const cursor = () => {
      const n = call++
      const c: any = { project: () => c, sort: () => c, limit: () => c, toArray: async () => (n === 0 ? batch : n < 3 ? [] : rest) }
      return c
    }
    vi.spyOn(DB, "connect").mockResolvedValue(DB as any)
    vi.spyOn(DB, "model").mockReturnValue({ find: cursor, findOne: async () => null } as any)
    const r = await pullChanges({ model: "f17_pull_reads", checkpoint: T - 1, batchSize: 200 })
    expect(r.documents).toHaveLength(600_200)
    expect(r.checkpoint).toBe(T)
  })
})

describe("probeUnpageable (advisor review)", () => {
  // The probe's { updatedAt: null, createdAt: { $not: { $type: "number" } } } branch examined every
  // row with no updatedAt — a retrofitted collection of 30 000 such rows, numeric createdAt and all,
  // was scanned every minute, for ever, since nothing was found. Each branch is a positive type
  // bracket now, an index range.
  it("probes with positive brackets only", async () => {
    const { _resetUnpageableProbe } = await import("@/server/sync")
    _resetUnpageableProbe()
    let probe: any
    const cursor = () => {
      const c: any = { project: () => c, sort: () => c, limit: () => c, toArray: async () => [] }
      return c
    }
    vi.spyOn(DB, "connect").mockResolvedValue(DB as any)
    vi.spyOn(DB, "model").mockReturnValue({ find: cursor, findOne: async (f: any) => ((probe = f), null) } as any)
    await pullChanges({ model: "f17_pull_reads", checkpoint: 1000 })
    expect(JSON.stringify(probe)).not.toMatch(/\$not/)
  })
})

describe("pullChanges: round F21", () => {
  // batchSize comes from the client: "all" became NaN — slice(0, NaN) answered nothing, for ever —
  // and 50.5 never equalled a batch's length, so a group was never completed. It is a whole number
  // from 1 to 1000 now, 200 when it is not a number.
  it("a batchSize that is not a whole number is made one", async () => {
    const limits: number[] = []
    const cursor = () => {
      const c: any = { project: () => c, sort: () => c, limit: (n: number) => (limits.push(n), c), toArray: async () => [] }
      return c
    }
    vi.spyOn(DB, "connect").mockResolvedValue(DB as any)
    vi.spyOn(DB, "model").mockReturnValue({ find: cursor, findOne: async () => null } as any)
    await pullChanges({ model: "f17_pull_reads", checkpoint: 1000, batchSize: "all" as any })
    await pullChanges({ model: "f17_pull_reads", checkpoint: 1000, batchSize: 50.5 })
    expect(new Set(limits)).toEqual(new Set([200, 50]))
  })

  // A numeric stamp of 0 or below (a backfill's "epoch" default) has page key 0: past the first
  // batch it is never pulled — and the probe looked only for strings, Dates and missing stamps.
  it("the probe also finds numeric stamps of 0 or below", async () => {
    const { _resetUnpageableProbe } = await import("@/server/sync")
    _resetUnpageableProbe()
    let probe: any
    const cursor = () => {
      const c: any = { project: () => c, sort: () => c, limit: () => c, toArray: async () => [] }
      return c
    }
    vi.spyOn(DB, "connect").mockResolvedValue(DB as any)
    vi.spyOn(DB, "model").mockReturnValue({ find: cursor, findOne: async (f: any) => ((probe = f), null) } as any)
    await pullChanges({ model: "f17_pull_reads", checkpoint: 1000 })
    expect(probe.$or).toContainEqual({ updatedAt: { $lte: 0 } })
  })
})
