import { describe, it, expect } from "vitest"
import {
  normalizeWatchInput,
  normalizeWatchInputToPipeline,
  prefixFilterWithFullDocument,
  bareFilterToChangeEventMatch,
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
