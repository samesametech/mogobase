// Normalize the second arg of `ctx.watch(model, ...)` into either:
//   - { kind: "hub", matchFilter }  → multiplexed streamHub, evaluated in JS
//                                     against the full MongoDB change event
//                                     (paths use the native shape:
//                                     "fullDocument.x", "operationType",
//                                     "documentKey._id", …).
//   - { kind: "pipeline", pipeline } → per-socket MongoDB collection.watch()
//                                     with the user-supplied aggregation
//                                     pipeline. Used when the input contains
//                                     stages other than $match (e.g. $project,
//                                     $addFields) that the JS matcher can't
//                                     emulate.
//
// Accepted input shapes — chosen to match how a developer writes a real
// `collection.watch(pipeline)` call:
//
//   ctx.watch(model)                                  // no filter
//   ctx.watch(model, { $match: { ... } })             // single stage object
//   ctx.watch(model, [{ $match: { ... } }, ...])      // full pipeline array
//   ctx.watch(model, { userId: "x" })                 // bare-filter shorthand
//
// Bare-filter shorthand exists for backward compatibility: keys are auto-
// prefixed with "fullDocument." and OR'd with `operationType: "delete"` so
// deletes (which carry no fullDocument) still notify the subscriber. This
// preserves the pre-revision "deletes always pass" semantic for legacy
// callers without forcing them to spell out the OR.

import type { Document } from "mongodb"
import type { MongoFilter } from "@/runtime/filterMatcher"

export type NormalizedWatch =
  | { kind: "hub"; matchFilter: MongoFilter | undefined }
  | { kind: "pipeline"; pipeline: Document[] }

// Aggregation stage operators we recognize. We don't need an exhaustive list —
// just enough to disambiguate "this object is a stage" vs "this object is a
// bare filter". $match is special-cased because it's the only stage the
// streamHub can evaluate in-process; everything else falls through to the
// per-socket MongoDB pipeline path.
const STAGE_OPS = new Set([
  "$match",
  "$project",
  "$addFields",
  "$set",
  "$unset",
  "$replaceRoot",
  "$replaceWith",
  "$redact",
  "$count",
  "$group",
  "$sort",
  "$limit",
  "$skip",
])

// Top-level filter operators (NOT stages). These can appear at the root of a
// bare filter: `{ $or: [...] }`, `{ $and: [...] }`, `{ $not: {...} }`.
const FILTER_TOP_OPS = new Set(["$or", "$and", "$not", "$nor"])

function isPlainObject(o: any): o is Record<string, any> {
  return o != null && typeof o === "object" && !Array.isArray(o) && !(o instanceof Date)
}

// Recursively prefix every non-operator key with "fullDocument." so a bare
// document filter (`{ userId: x }`) becomes a change-event filter
// (`{ "fullDocument.userId": x }`). Operator keys ($and/$or/$not/$nor) recurse;
// other top-level $-keys are passed through unchanged so unknown operators
// surface to isSupportedFilter rather than silently being mangled.
export function prefixFilterWithFullDocument(filter: MongoFilter): MongoFilter {
  const out: MongoFilter = {}
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$and" || k === "$or" || k === "$nor") {
      out[k] = (v as any[]).map((sub) => prefixFilterWithFullDocument(sub))
    } else if (k === "$not") {
      out[k] = prefixFilterWithFullDocument(v as MongoFilter)
    } else if (k.startsWith("$")) {
      out[k] = v
    } else {
      out[`fullDocument.${k}`] = v
    }
  }
  return out
}

// Translate a bare doc-filter (`{ userId: x }`, `{ $or: [{a:1},{b:2}] }`) into
// a $match-shaped filter on the change event, OR'd with `operationType:
// "delete"` so subscribers still see tombstones (deletes carry no fullDocument
// and would otherwise never match a fullDocument.X predicate).
export function bareFilterToChangeEventMatch(
  filter: MongoFilter | undefined
): MongoFilter | undefined {
  if (!filter || Object.keys(filter).length === 0) return undefined
  return {
    $or: [prefixFilterWithFullDocument(filter), { operationType: "delete" }],
  }
}

// Decide whether an object is a single aggregation stage (e.g. `{ $match: {...} }`)
// rather than a bare filter (`{ userId: "x" }`). A stage object has exactly
// one top-level key and that key is a known stage name.
function isStageObject(input: Record<string, any>): boolean {
  const keys = Object.keys(input)
  if (keys.length !== 1) return false
  const k = keys[0]
  return k.startsWith("$") && STAGE_OPS.has(k)
}

// Return the merged $match filter if the pipeline is composed entirely of
// $match stages; otherwise return null to signal "fall through to MongoDB".
function tryExtractMatchFromPipeline(pipeline: Document[]): MongoFilter | null {
  if (pipeline.length === 0) return {}
  const matches: MongoFilter[] = []
  for (const stage of pipeline) {
    if (!isPlainObject(stage)) return null
    const keys = Object.keys(stage)
    if (keys.length !== 1 || keys[0] !== "$match") return null
    matches.push((stage as any).$match as MongoFilter)
  }
  if (matches.length === 1) return matches[0]
  return { $and: matches }
}

export function normalizeWatchInput(
  input: Document[] | Document | undefined
): NormalizedWatch {
  if (input == null) return { kind: "hub", matchFilter: undefined }

  if (Array.isArray(input)) {
    if (input.length === 0) return { kind: "hub", matchFilter: undefined }
    const merged = tryExtractMatchFromPipeline(input as Document[])
    if (merged !== null) {
      return { kind: "hub", matchFilter: Object.keys(merged).length ? merged : undefined }
    }
    return { kind: "pipeline", pipeline: input as Document[] }
  }

  if (isPlainObject(input)) {
    if (isStageObject(input)) {
      const stageKey = Object.keys(input)[0]
      if (stageKey === "$match") {
        const m = (input as any).$match as MongoFilter
        return { kind: "hub", matchFilter: m && Object.keys(m).length ? m : undefined }
      }
      // Other single-stage objects (e.g. $project) — wrap in array and
      // hand to MongoDB. The streamHub can't emulate them in JS.
      return { kind: "pipeline", pipeline: [input as Document] }
    }
    // Bare filter shorthand — could be `{ userId: x }` or `{ $or: [...] }`.
    // Both are filter-on-doc shapes; translate to change-event $match.
    const keys = Object.keys(input)
    const isFilterShape = keys.every(
      (k) => !k.startsWith("$") || FILTER_TOP_OPS.has(k)
    )
    if (isFilterShape) {
      return {
        kind: "hub",
        matchFilter: bareFilterToChangeEventMatch(input as MongoFilter),
      }
    }
    // Unknown $-key at top level — fall through to MongoDB so it surfaces a
    // real error rather than being silently treated as a doc filter.
    return { kind: "pipeline", pipeline: [{ $match: input as Document } as Document] }
  }

  return { kind: "hub", matchFilter: undefined }
}

// Convenience for callers that don't have a streamHub (legacy Hono ws.ts):
// always produce a MongoDB-side aggregation pipeline. Hub-style hits are
// re-wrapped as `[{ $match: matchFilter }]` so the same input shapes work.
export function normalizeWatchInputToPipeline(
  input: Document[] | Document | undefined
): Document[] {
  const normalized = normalizeWatchInput(input)
  if (normalized.kind === "pipeline") return normalized.pipeline
  return normalized.matchFilter ? [{ $match: normalized.matchFilter } as Document] : []
}
