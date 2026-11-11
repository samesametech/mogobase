// A paginated re-run re-reads the loaded window in pages the pager will actually serve.
import { describe, expect, it } from "vitest"
import { readWindow } from "@/server/liveQuery"

// A pager over N rows that clamps every limit to `max`, like mongo-cursor-pagination's MAX_LIMIT.
function pager(total: number, max = 300) {
  const rows = Array.from({ length: total }, (_, i) => ({ _id: i }))
  const calls: any[] = []
  const readPage = async (opts: any) => {
    calls.push(opts)
    const from = opts.next ? Number(opts.next) : 0
    const page = rows.slice(from, from + Math.min(opts.limit, max))
    const end = from + page.length
    return {
      results: page,
      previous: from ? String(from) : undefined,
      hasPrevious: from > 0,
      next: end < total ? String(end) : undefined,
      hasNext: end < total,
    }
  }
  return { readPage, calls }
}
const sort = { sortAscending: true, sortCaseInsensitive: false }

describe("readWindow", () => {
  it("reads past the pager's clamp in pages, and answers as one page", async () => {
    const p = pager(1000)
    const rs = await readWindow(650, p.readPage, sort)
    expect(rs.results.map((r: any) => r._id)).toEqual(Array.from({ length: 650 }, (_, i) => i))
    expect(p.calls.map((c) => c.limit)).toEqual([300, 300, 50])
    expect(p.calls.map((c) => c.next)).toEqual([undefined, "300", "600"])
    expect(rs).toMatchObject({ hasPrevious: false, previous: undefined, hasNext: true, next: "650" })
  })

  it("a window within one page is exactly the one call it always was", async () => {
    const p = pager(1000)
    await readWindow(120, p.readPage, sort)
    expect(p.calls).toEqual([{ limit: 120, sortAscending: true, sortCaseInsensitive: false }])
  })

  it("stops at the end of the data", async () => {
    const p = pager(420)
    const rs = await readWindow(900, p.readPage, sort)
    expect(rs.results).toHaveLength(420)
    expect(rs.hasNext).toBe(false)
  })

  it("keeps walking when a handler clamps lower than 300", async () => {
    const p = pager(1000, 100)
    const rs = await readWindow(350, p.readPage, sort)
    expect(rs.results).toHaveLength(350)
    expect(p.calls).toHaveLength(4)
  })

  it("never loops on a handler whose cursor does not advance", async () => {
    let calls = 0
    const stuck = async () => {
      calls++
      return { results: [{ _id: calls }], hasNext: true, next: "same" }
    }
    const rs = await readWindow(900, stuck, sort)
    expect(calls).toBe(2)
    expect(rs.results).toHaveLength(2)
    // …and does not hand that cursor on: a load-next would fetch the same page again.
    expect(rs.hasNext).toBe(false)
    expect(rs.next).toBeUndefined()
  })
})

describe("readWindow: a window that starts before a cursor (review round 12)", () => {
  // A pager over 1000 rows that serves pages of any size (no 300 clamp), both directions.
  const rows = Array.from({ length: 1000 }, (_, i) => i)
  const pager = async (o: any) => {
    let from: number, to: number
    if (o.previous) {
      to = Number(o.previous)
      from = Math.max(0, to - o.limit)
    } else {
      from = o.next ? Number(o.next) : 0
      to = Math.min(rows.length, from + o.limit)
    }
    return { results: rows.slice(from, to), previous: String(from), hasPrevious: from > 0, next: String(to), hasNext: to < rows.length }
  }

  it("reads back more than one page of rows before the cursor, walking backward", async () => {
    const rs = await readWindow(600, pager, {}, 300, { previous: "800", count: 500 })
    expect(rs.results[0]).toBe(300) // the window's first row, not 500
    expect(rs.results).toHaveLength(600)
    expect(rs.results.at(-1)).toBe(899) // and on through the rows after the cursor
    expect(rs.hasPrevious).toBe(true)
  })
})

// mongo-cursor-pagination's answers, over the ids that still exist: `next: c` reads ids after c,
// `previous: c` the nearest ids before c; prepareResponse's flags and cursors — notably an empty
// `previous` page answers hasNext: true with no `next`, an empty `next` page hasPrevious: true
// with no `previous`.
function cursorPager(ids: number[]) {
  const readPage = async (opts: any) => {
    const limit = opts.limit
    let rows: number[]
    let hasMore: boolean
    if (opts.previous !== undefined) {
      const before = ids.filter((id) => id < Number(opts.previous))
      hasMore = before.length > limit
      rows = before.slice(-limit)
    } else {
      const after = opts.next !== undefined ? ids.filter((id) => id > Number(opts.next)) : ids
      hasMore = after.length > limit
      rows = after.slice(0, limit)
    }
    return {
      results: rows.map((_id) => ({ _id })),
      previous: rows.length ? String(rows[0]) : undefined,
      hasPrevious: opts.next !== undefined || (opts.previous !== undefined && hasMore),
      next: rows.length ? String(rows[rows.length - 1]) : undefined,
      hasNext: opts.previous !== undefined || hasMore,
    }
  }
  return { readPage }
}

describe("readWindow: a start with nothing left on its side (review round 15)", () => {
  it("a window that began before a cursor, whose rows are all gone, reads from the top — not an empty list", async () => {
    // The window grew upward to 3 rows before id 5; ids 0-4 were then deleted.
    const p = cursorPager([5, 6, 7, 8, 9])
    let fromTop = 0
    const rs = await readWindow(8, p.readPage, sort, 300, { previous: "5", count: 3 }, () => fromTop++)
    expect(rs.results.map((r: any) => r._id)).toEqual([5, 6, 7, 8, 9]) // was [] with hasNext: true, next: undefined
    expect(rs.hasPrevious).toBe(false)
    expect(fromTop).toBe(1)
  })

  it("a window that began after a cursor, whose rows are all gone, reads from the top — loadPrevious was stuck", async () => {
    // Restored at a scroll position after id 7; ids 8 and 9 were then deleted.
    const p = cursorPager([0, 1, 2, 3, 4, 5, 6, 7])
    let fromTop = 0
    const rs = await readWindow(5, p.readPage, sort, 300, { next: "7" }, () => fromTop++)
    expect(rs.results.map((r: any) => r._id)).toEqual([0, 1, 2, 3, 4]) // was [] with hasPrevious: true, previous: undefined
    expect(rs.hasPrevious).toBe(false)
    expect(rs.hasNext).toBe(true)
    expect(fromTop).toBe(1)
  })

  it("a start with rows still on its side reads from it, as before", async () => {
    const p = cursorPager([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    let fromTop = 0
    const rs = await readWindow(3, p.readPage, sort, 300, { next: "4" }, () => fromTop++)
    expect(rs.results.map((r: any) => r._id)).toEqual([5, 6, 7])
    expect(fromTop).toBe(0)
  })
})
