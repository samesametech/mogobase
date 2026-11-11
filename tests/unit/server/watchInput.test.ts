import { describe, it, expect } from "vitest"
import {
  normalizeWatchInput,
  normalizeWatchInputToPipeline,
  prefixFilterWithFullDocument,
  bareFilterToChangeEventMatch,
  normalizeIgnoreFields,
  touchesOnlyIgnored,
  routeWatchInput,
} from "@/server/watchInput"

describe("normalizeWatchInput: hub path", () => {
  it("undefined → no filter", () => {
    expect(normalizeWatchInput(undefined)).toEqual({
      kind: "hub",
      matchFilter: undefined,
    })
  })

  it("empty array → no filter", () => {
    expect(normalizeWatchInput([])).toEqual({
      kind: "hub",
      matchFilter: undefined,
    })
  })

  it("single $match stage object → extracted filter", () => {
    const input = {
      $match: {
        $or: [
          { "fullDocument.documentId": "abc" },
          { operationType: "delete" },
        ],
      },
    }
    expect(normalizeWatchInput(input)).toEqual({
      kind: "hub",
      matchFilter: input.$match,
    })
  })

  it("single-stage $match in array → extracted filter", () => {
    const input = [{ $match: { operationType: "insert" } }]
    expect(normalizeWatchInput(input)).toEqual({
      kind: "hub",
      matchFilter: { operationType: "insert" },
    })
  })

  it("multi-stage all-$match array → merged via $and", () => {
    const input = [
      { $match: { "fullDocument.userId": "u1" } },
      { $match: { operationType: { $ne: "delete" } } },
    ]
    expect(normalizeWatchInput(input)).toEqual({
      kind: "hub",
      matchFilter: {
        $and: [
          { "fullDocument.userId": "u1" },
          { operationType: { $ne: "delete" } },
        ],
      },
    })
  })
})

describe("normalizeWatchInput: bare-filter shorthand", () => {
  it("bare doc filter → fullDocument-prefixed + delete OR", () => {
    const out = normalizeWatchInput({ userId: "alice" })
    expect(out).toEqual({
      kind: "hub",
      matchFilter: {
        $or: [{ "fullDocument.userId": "alice" }, { operationType: "delete" }],
      },
    })
  })

  it("bare filter with $or at top level → recurses into branches", () => {
    const out = normalizeWatchInput({
      $or: [{ a: 1 }, { b: 2 }],
    })
    expect(out).toEqual({
      kind: "hub",
      matchFilter: {
        $or: [
          {
            $or: [{ "fullDocument.a": 1 }, { "fullDocument.b": 2 }],
          },
          { operationType: "delete" },
        ],
      },
    })
  })
})

describe("normalizeWatchInput: pipeline path", () => {
  it("non-$match stage object → wrapped pipeline", () => {
    const input = { $project: { _id: 1, name: 1 } }
    expect(normalizeWatchInput(input)).toEqual({
      kind: "pipeline",
      pipeline: [input],
    })
  })

  it("multi-stage array with non-$match stages → pass through", () => {
    const input = [
      { $match: { operationType: "insert" } },
      { $project: { _id: 1 } },
    ]
    expect(normalizeWatchInput(input)).toEqual({
      kind: "pipeline",
      pipeline: input,
    })
  })
})

describe("normalizeWatchInputToPipeline (legacy ws.ts helper)", () => {
  it("converts a hub matchFilter into [{ $match }]", () => {
    expect(
      normalizeWatchInputToPipeline({ $match: { operationType: "insert" } })
    ).toEqual([{ $match: { operationType: "insert" } }])
  })

  it("converts a bare filter into a pipeline with prefixed paths and delete OR", () => {
    expect(normalizeWatchInputToPipeline({ userId: "x" })).toEqual([
      {
        $match: {
          $or: [{ "fullDocument.userId": "x" }, { operationType: "delete" }],
        },
      },
    ])
  })

  it("undefined → empty pipeline", () => {
    expect(normalizeWatchInputToPipeline(undefined)).toEqual([])
  })

  it("non-$match stage → forwarded as a single-element pipeline", () => {
    const stage = { $project: { _id: 1 } }
    expect(normalizeWatchInputToPipeline(stage)).toEqual([stage])
  })
})

describe("prefixFilterWithFullDocument", () => {
  it("prefixes plain keys", () => {
    expect(prefixFilterWithFullDocument({ a: 1, b: 2 })).toEqual({
      "fullDocument.a": 1,
      "fullDocument.b": 2,
    })
  })

  it("recurses into $and / $or", () => {
    expect(
      prefixFilterWithFullDocument({
        $and: [{ a: 1 }, { $or: [{ b: 2 }, { c: 3 }] }],
      })
    ).toEqual({
      $and: [
        { "fullDocument.a": 1 },
        { $or: [{ "fullDocument.b": 2 }, { "fullDocument.c": 3 }] },
      ],
    })
  })

  it("recurses into $not", () => {
    expect(prefixFilterWithFullDocument({ $not: { a: 1 } })).toEqual({
      $not: { "fullDocument.a": 1 },
    })
  })
})

describe("bareFilterToChangeEventMatch", () => {
  it("undefined / empty → undefined", () => {
    expect(bareFilterToChangeEventMatch(undefined)).toBeUndefined()
    expect(bareFilterToChangeEventMatch({})).toBeUndefined()
  })

  it("OR's translated filter with operationType:delete", () => {
    expect(bareFilterToChangeEventMatch({ userId: "u1" })).toEqual({
      $or: [{ "fullDocument.userId": "u1" }, { operationType: "delete" }],
    })
  })
})

// ——— ignoreFields: a watch can sit out updates that changed nothing it cares about.
const update = (updatedFields: Record<string, unknown>, removedFields: string[] = [], truncatedArrays: any[] = []) => ({
  operationType: "update",
  updateDescription: { updatedFields, removedFields, truncatedArrays },
})

describe("normalizeIgnoreFields", () => {
  it("adds updatedAt, dedupes and sorts; nothing usable means no option", () => {
    expect(normalizeIgnoreFields(["splitCheckedAt", "reconciledAt", "reconciledAt"])).toEqual([
      "reconciledAt",
      "splitCheckedAt",
      "updatedAt",
    ])
    expect(normalizeIgnoreFields(undefined)).toBeUndefined()
    expect(normalizeIgnoreFields([])).toBeUndefined()
    expect(normalizeIgnoreFields(["", 3, null])).toBeUndefined()
    expect(normalizeIgnoreFields("reconciledAt")).toBeUndefined()
  })
})

describe("touchesOnlyIgnored", () => {
  const ignore = normalizeIgnoreFields(["reconciledAt", "meta"])!

  it("an update of ignored fields (plus the engine's updatedAt) is skipped", () => {
    expect(touchesOnlyIgnored(update({ reconciledAt: 1, updatedAt: 2 }), ignore)).toBe(true)
    expect(touchesOnlyIgnored(update({ "meta.at": 1 }, ["meta.old"]), ignore)).toBe(true)
  })

  it("any other changed path wakes the watch", () => {
    expect(touchesOnlyIgnored(update({ reconciledAt: 1, status: "paid" }), ignore)).toBe(false)
    expect(touchesOnlyIgnored(update({ reconciledAtX: 1 }), ignore)).toBe(false)
    expect(touchesOnlyIgnored(update({}, ["status"]), ignore)).toBe(false)
    expect(touchesOnlyIgnored(update({}, [], [{ field: "lines", newSize: 1 }]), ignore)).toBe(false)
  })

  it("a parent of an ignored path is not ignored", () => {
    expect(touchesOnlyIgnored(update({ meta: {} }), normalizeIgnoreFields(["meta.at"])!)).toBe(false)
  })

  it("inserts, replaces, deletes, and updates with no description always wake", () => {
    for (const operationType of ["insert", "replace", "delete"]) {
      expect(touchesOnlyIgnored({ operationType, updateDescription: { updatedFields: { reconciledAt: 1 } } }, ignore)).toBe(false)
    }
    expect(touchesOnlyIgnored({ operationType: "update" }, ignore)).toBe(false)
    expect(touchesOnlyIgnored(update({}), ignore)).toBe(false)
  })
})

describe("watch inputs MongoDB runs (review round 9)", () => {
  it("a bare filter with a top-level $expr is still a filter on the document: prefixed, deletes kept", async () => {
    const { routeWatchInput } = await import("@/server/watchInput")
    const expr = { $gt: ["$fullDocument.total", 100] }
    const route: any = routeWatchInput({ orgId: "x", $expr: expr })
    expect(route.kind).toBe("pipeline")
    expect(route.pipeline).toEqual([{ $match: { $or: [{ "fullDocument.orgId": "x", $expr: expr }, { operationType: "delete" }] } }])
  })

  it("the legacy transport's pipeline turns a logical $not into $nor", async () => {
    const { normalizeWatchInputToPipeline } = await import("@/server/watchInput")
    expect(normalizeWatchInputToPipeline({ $not: { done: true } })).toEqual([
      { $match: { $or: [{ $nor: [{ "fullDocument.done": true }] }, { operationType: "delete" }] } },
    ])
  })
})

describe("watchInput: review round 13", () => {
  // `.map` on a non-array $or threw a TypeError from inside ctx.watch, failing the whole run.
  // Passed through, it is a filter only MongoDB can judge: it gets a stream of its own, whose
  // open MongoDB refuses with its own message ("$or must be an array"), retried on the backoff.
  it("a non-array $or/$and/$nor, or a non-object $not, is passed through, not mapped", () => {
    expect(() => prefixFilterWithFullDocument({ $or: { a: 1 } } as any)).not.toThrow()
    expect(prefixFilterWithFullDocument({ $or: { a: 1 }, b: 2 } as any)).toEqual({ $or: { a: 1 }, "fullDocument.b": 2 })
    expect(prefixFilterWithFullDocument({ $and: "x", $nor: 3, $not: "y" } as any)).toEqual({ $and: "x", $nor: 3, $not: "y" })
    const route: any = routeWatchInput({ $or: { a: 1 } })
    expect(route.kind).toBe("pipeline")
    expect(route.reason).toBe("operator $or")
  })
})

describe("watchInput: review round 14", () => {
  it("exprPaths moves $expr field paths onto fullDocument, leaving variables and $literal alone", () => {
    const filter = { org: "o1", $or: [{ $expr: { $eq: ["$ownerId", "$$userVar"] } }, { $expr: { $eq: [{ $literal: "$x" }, "$a.b"] } }] }
    expect(prefixFilterWithFullDocument(filter, true)).toEqual({
      "fullDocument.org": "o1",
      $or: [
        { $expr: { $eq: ["$fullDocument.ownerId", "$$userVar"] } },
        { $expr: { $eq: [{ $literal: "$x" }, "$fullDocument.a.b"] } },
      ],
    })
  })

  it("without it (a live query's watch), $expr stays as the handler wrote it", () => {
    const filter = { $expr: { $eq: ["$fullDocument.ownerId", "u1"] } }
    expect(prefixFilterWithFullDocument(filter)).toEqual(filter)
  })
})

describe("watchInput: review round F1", () => {
  // On a document $$ROOT / $$CURRENT is the row; on a change event they are the event. A sync
  // policy writing $$ROOT.orgId pulled the right rows and streamed nothing.
  it("exprPaths moves $$ROOT and $$CURRENT onto fullDocument too; other variables stay", () => {
    const filter = { $expr: { $and: [{ $eq: ["$$ROOT.orgId", "o1"] }, { $eq: ["$$CURRENT.kind", "$$k"] }, { $gt: ["$$NOW", 0] }, { $ne: ["$$ROOT", null] }] } }
    expect(prefixFilterWithFullDocument(filter, true)).toEqual({
      $expr: {
        $and: [
          { $eq: ["$fullDocument.orgId", "o1"] },
          { $eq: ["$fullDocument.kind", "$$k"] },
          { $gt: ["$$NOW", 0] },
          { $ne: ["$fullDocument", null] },
        ],
      },
    })
  })
})

describe("watchInput: review round F2", () => {
  // Inside a $let that rebinds CURRENT, $$CURRENT and "$field" (its shorthand) are that value, not
  // the document: rewritten, the stream's $match broke and sync-subscribe retried it forever.
  it("leaves $$CURRENT and field paths alone inside a $let that rebinds CURRENT", () => {
    const filter = { $expr: { $let: { vars: { CURRENT: "$items" }, in: { $gt: [{ $size: "$$CURRENT" }, "$minimum"] } } } }
    expect(prefixFilterWithFullDocument(filter, true)).toEqual({
      $expr: { $let: { vars: { CURRENT: "$fullDocument.items" }, in: { $gt: [{ $size: "$$CURRENT" }, "$minimum"] } } },
    })
  })

  it("a $let binding other names is rewritten as before, $$ROOT included", () => {
    const filter = { $expr: { $let: { vars: { k: "$kind" }, in: { $and: [{ $eq: ["$$k", "$kind"] }, { $ne: ["$$ROOT.x", null] }] } } } }
    expect(prefixFilterWithFullDocument(filter, true)).toEqual({
      $expr: { $let: { vars: { k: "$fullDocument.kind" }, in: { $and: [{ $eq: ["$$k", "$fullDocument.kind"] }, { $ne: ["$fullDocument.x", null] }] } } },
    })
  })
})

describe("watchInput: review round F7", () => {
  // exprOnFullDocument walked BSON values as plain objects: an ObjectId in a sync policy's $expr
  // became { buffer: {…} } and a RegExp {}, so the stream's $match never matched.
  it("leaves ObjectId, RegExp, Decimal128 and Date values in a sync $expr as they are", async () => {
    const { ObjectId, Decimal128 } = await import("mongodb")
    const id = new ObjectId()
    const price = Decimal128.fromString("9.99")
    const when = new Date(0)
    const re = /^a/i
    const out: any = prefixFilterWithFullDocument({ $expr: { $and: [{ $eq: ["$orgId", id] }, { $gt: ["$price", price] }, { $lt: ["$at", when] }, { $regexMatch: { input: "$name", regex: re } }] } }, true)
    const [eq, gt, lt, rx] = out.$expr.$and
    expect(eq.$eq[1]).toBe(id)
    expect(gt.$gt[1]).toBe(price)
    expect(lt.$lt[1]).toBe(when)
    expect(rx.$regexMatch.regex).toBe(re)
    expect(eq.$eq[0]).toBe("$fullDocument.orgId")
  })
})

describe("routeWatchInput: review round F14", () => {
  // A watch filter using $where, $text or $near went to a change stream of its own, which MongoDB
  // always refuses: the watch was reopened at 1 s … 30 s for the socket's life — a stream open and a
  // pooled connection each time — and the live query never updated. The sync path already left
  // such a stream unnarrowed. A watch only says when to re-run: unnarrowed, every write to the
  // collection re-runs the query (its handler, auth included), which updates; nothing leaks.
  it("a filter a change stream cannot run watches the whole collection on the hub", async () => {
    const { routeWatchInput } = await import("@/server/watchInput")
    expect(routeWatchInput({ $text: { $search: "x" } })).toEqual({ kind: "hub", matchFilter: undefined, unnarrowed: "$text" })
    expect(routeWatchInput({ $where: "this.a > 1", org: "o" })).toEqual({ kind: "hub", matchFilter: undefined, unnarrowed: "$where" })
    expect(routeWatchInput([{ $match: { "fullDocument.loc": { $near: [0, 0] } } }, { $project: { fullDocument: 1 } }])).toEqual({
      kind: "hub",
      matchFilter: undefined,
      unnarrowed: "$near",
    })
    expect(routeWatchInput({ org: "o" })).toMatchObject({ kind: "hub" }) // unchanged
    expect((routeWatchInput({ org: "o" }) as any).unnarrowed).toBeUndefined()
  })
})
