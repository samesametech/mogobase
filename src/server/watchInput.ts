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

import { isPlainDocument } from "@/runtime/plainDocument"
import type { Document } from "mongodb"
import { isSupportedFilter, unsupportedOperator, type MongoFilter } from "@/runtime/filterMatcher"

export type NormalizedWatch =
  | {
      kind: "hub"
      matchFilter: MongoFilter | undefined
      /** An operator no change stream runs ($where, $text, $near), for which it watches the whole collection. */
      unnarrowed?: string
    }
  | { kind: "pipeline"; pipeline: Document[]; /** Why the shared hub cannot take it (routeWatchInput). */ reason?: string }

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

// Recursively prefix every non-operator key with "fullDocument." so a bare
// document filter (`{ userId: x }`) becomes a change-event filter
// (`{ "fullDocument.userId": x }`). Operator keys ($and/$or/$not/$nor) recurse;
// other top-level $-keys — and a malformed $and/$or/$nor (not an array) or $not (not an
// object), which `.map` used to throw a TypeError on from inside ctx.watch — are passed
// through unchanged, so they surface to isSupportedFilter rather than silently being mangled,
// and MongoDB, on the stream of their own they get, refuses them with its own message.
//
// `exprPaths` also moves the field paths inside `$expr` ("$userId" → "$fullDocument.userId"),
// for a filter written against documents that must also run on change events — a sync policy's,
// which pull applies to the rows themselves. A live query's watch filter is written for the
// event: inside its `$expr` the handler writes `$fullDocument.field`, and it is left as written.
export function prefixFilterWithFullDocument(filter: MongoFilter, exprPaths = false): MongoFilter {
  const out: MongoFilter = {}
  for (const [k, v] of Object.entries(filter)) {
    if ((k === "$and" || k === "$or" || k === "$nor") && Array.isArray(v)) {
      out[k] = v.map((sub) => prefixFilterWithFullDocument(sub, exprPaths))
    } else if (k === "$not" && isPlainDocument(v)) {
      out[k] = prefixFilterWithFullDocument(v as MongoFilter, exprPaths)
    } else if (k === "$expr" && exprPaths) {
      out[k] = exprOnFullDocument(v)
    } else if (k === "$jsonSchema" && isPlainDocument(v)) {
      // A document's schema, checked against the event's fullDocument: passed through, it was
      // checked against the change event, which never satisfies it — nothing ever matched.
      out[k] = { required: ["fullDocument"], properties: { fullDocument: v } }
    } else if (k.startsWith("$")) {
      out[k] = v
    } else {
      out[`fullDocument.${k}`] = v
    }
  }
  return out
}

// An aggregation expression with its field paths ("$a.b") read from the change event's
// fullDocument — and $$ROOT / $$CURRENT, which on a document are the row and on a change event
// the event, so "$$ROOT.orgId" matched nothing on the stream. Other variables ("$$NOW", a $let's)
// and `$literal` values are left as they are.
//
// `currentIsDoc` is false inside a $let that rebinds CURRENT: there $$CURRENT and a "$field"
// path (its shorthand) are that value, not the document, and are left as written. $$ROOT cannot
// be rebound.
function exprOnFullDocument(expr: unknown, currentIsDoc = true): unknown {
  if (typeof expr === "string") {
    const root = /^\$\$(ROOT|CURRENT)(\.|$)/.exec(expr)
    if (root && (root[1] === "ROOT" || currentIsDoc)) return `$fullDocument${expr.slice(root[0].length - (root[2] ? 1 : 0))}`
    return currentIsDoc && expr.startsWith("$") && !expr.startsWith("$$") ? `$fullDocument.${expr.slice(1)}` : expr
  }
  if (Array.isArray(expr)) return expr.map((item) => exprOnFullDocument(item, currentIsDoc))
  if (!isPlainDocument(expr)) return expr
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(expr)) {
    if (k === "$literal") out[k] = v
    else if (k === "$let" && isPlainDocument(v)) {
      const vars = isPlainDocument(v.vars) ? v.vars : {}
      const rebindsCurrent = Object.hasOwn(vars, "CURRENT")
      out[k] = {
        ...v,
        vars: exprOnFullDocument(v.vars, currentIsDoc), // evaluated outside the $let's scope
        in: exprOnFullDocument(v.in, currentIsDoc && !rebindsCurrent),
      }
    } else out[k] = exprOnFullDocument(v, currentIsDoc)
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
    if (!isPlainDocument(stage)) return null
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

  if (isPlainDocument(input)) {
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
    // Bare filter shorthand — `{ userId: x }`, `{ $or: [...] }`, or one with an operator only
    // MongoDB runs at its top (`{ orgId: x, $expr: … }`). All are filters on the DOCUMENT: their
    // fields are prefixed with `fullDocument.` and deletes OR'd in. One with a top-level $expr or
    // $where used to go to MongoDB as it was: matched against the change event, `orgId` was never
    // there, and the query never re-ran (routeWatchInput sends it to a stream of its own; inside
    // $expr, a field is `$fullDocument.total`).
    return { kind: "hub", matchFilter: bareFilterToChangeEventMatch(input as MongoFilter) }
  }

  return { kind: "hub", matchFilter: undefined }
}

/**
 * Where a watch is evaluated: on the shared hub, when its input is `$match`-only and the hub's
 * JS matcher can run the filter; else on a change stream of its own, where MongoDB runs it — a
 * pipeline with other stages, or a filter with $elemMatch, $expr, $where, $text, … The one rule
 * for live-query watches (attachWs) and sync streams (subscribeSyncStream); on the hub alone
 * such a filter threw at subscribe and the watch was dropped.
 */
export function routeWatchInput(input: Document[] | Document | undefined): NormalizedWatch {
  // An operator no change stream runs: the whole collection, on the hub (see unstreamableOperator).
  const unnarrowed = unstreamableOperator(input)
  if (unnarrowed) return { kind: "hub", matchFilter: undefined, unnarrowed }
  const normalized = normalizeWatchInput(input)
  if (normalized.kind === "hub" && !isSupportedFilter(normalized.matchFilter)) {
    return {
      kind: "pipeline",
      pipeline: [{ $match: toServerMatch(normalized.matchFilter) }],
      reason: `operator ${unsupportedOperator(normalized.matchFilter)}`,
    }
  }
  if (normalized.kind === "pipeline") {
    const pipeline = normalized.pipeline.map((stage) =>
      stage && typeof stage === "object" && "$match" in stage ? { ...stage, $match: toServerMatch((stage as any).$match) } : stage
    )
    return { kind: "pipeline", pipeline, reason: pipelineReason(normalized.pipeline) }
  }
  return normalized
}

/**
 * The first operator in `value` a change stream's $match cannot run: $text runs only as a
 * collection's first stage, $where and the $near family not in an aggregation at all. A watch
 * (or a sync stream) using one used to go to a change stream of its own, which MongoDB refused
 * on every attempt, retried for good: it never told anyone of a write. routeWatchInput sends it
 * to the hub unnarrowed instead — a watch only says when to re-run (a live query's handler, auth
 * included, decides what is sent; a sync-stream frame names the model only), so it costs runs,
 * never secrecy.
 */
export function unstreamableOperator(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = unstreamableOperator(item)
      if (found) return found
    }
    return undefined
  }
  if (!isPlainDocument(value)) return undefined
  for (const [key, inner] of Object.entries(value)) {
    if (UNSTREAMABLE.has(key)) return key
    const found = unstreamableOperator(inner)
    if (found) return found
  }
  return undefined
}
const UNSTREAMABLE = new Set(["$where", "$text", "$near", "$nearSphere"])

/**
 * A filter MongoDB can run: a `$not` in a logical position (`{ $not: X }`), which the JS matcher
 * accepts and MongoDB rejects as an unknown top-level operator, becomes `{ $nor: [X] }`. A
 * filter with both such a `$not` and an operator only MongoDB runs ($elemMatch) went to its
 * own stream as it was, MongoDB refused it every time, and the watch was retried forever.
 */
export function toServerMatch(filter: any): any {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return filter
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$not") out.$nor = [...(out.$nor ?? []), toServerMatch(value)]
    else if ((key === "$and" || key === "$or" || key === "$nor") && Array.isArray(value)) {
      const mapped = value.map(toServerMatch)
      out[key] = key === "$nor" ? [...(out.$nor ?? []), ...mapped] : mapped
    } else out[key] = value
  }
  return out
}

// What in a pipeline keeps it off the hub: a stage other than $match, or an operator in one.
function pipelineReason(pipeline: Document[]): string {
  for (const stage of pipeline) {
    const [key] = Object.keys(stage ?? {})
    if (key !== "$match") return `stage ${key}`
    const op = unsupportedOperator((stage as any).$match)
    if (op) return `operator ${op}`
  }
  return "a pipeline the shared stream cannot evaluate"
}

// Convenience for callers that don't have a streamHub (legacy Hono ws.ts):
// always produce a MongoDB-side aggregation pipeline. Hub-style hits are
// re-wrapped as `[{ $match: matchFilter }]` so the same input shapes work.
export function normalizeWatchInputToPipeline(
  input: Document[] | Document | undefined
): Document[] {
  return pipelineOf(routeWatchInput(input))
}

/**
 * A routed watch as a pipeline MongoDB runs: routeWatchInput's $match stages are ones it can run
 * (a top-level $not becomes $nor), and an unnarrowed watch is no stage at all — the whole
 * collection. For the legacy ws.ts, where every watch is a change stream of its own.
 */
export function pipelineOf(routed: NormalizedWatch): Document[] {
  if (routed.kind === "pipeline") return routed.pipeline
  return routed.matchFilter ? [{ $match: toServerMatch(routed.matchFilter) } as Document] : []
}

/**
 * A watch's `ignoreFields`, cleaned: unique non-empty strings, sorted, plus `updatedAt` —
 * every write through mogobase stamps it, so on its own it says nothing. Undefined when the
 * option is absent or names no field, which leaves the watch exactly as it was.
 */
export function normalizeIgnoreFields(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const fields = value.filter((f): f is string => typeof f === "string" && f.length > 0)
  if (!fields.length) return undefined
  return [...new Set([...fields, "updatedAt"])].sort()
}

/**
 * Whether a change event is an UPDATE that changed nothing but ignored fields — the event a
 * watch with `ignoreFields` skips. A path counts as ignored when it is an ignored field or
 * lies under one (`meta.at` under `meta`). Inserts, replaces and deletes never count, nor an
 * update whose description is missing or lists no path: when in doubt, the watch wakes.
 *
 * This is what lets a subscriber sit out a cron that stamps `reconciledAt` on every row of
 * its org: the stamp still matches the subscriber's org filter, so without it each stamp
 * re-ran the query for a result that had not changed.
 */
export function touchesOnlyIgnored(change: any, ignore: readonly string[]): boolean {
  return onlyIgnoredPaths(changedPaths(change), ignore)
}

/**
 * The paths an update changed (updatedFields, removedFields, truncatedArrays), or null for any
 * other change — which ignoreFields never skips. Computed once per change by the hub, not once
 * per subscriber: with thousands of subscribers on a hot collection that was thousands of
 * array builds per update.
 */
export function changedPaths(change: any): string[] | null {
  if (change?.operationType !== "update") return null
  const desc = change.updateDescription
  if (!desc || typeof desc !== "object") return null
  return [
    ...Object.keys(desc.updatedFields ?? {}),
    ...(Array.isArray(desc.removedFields) ? desc.removedFields : []),
    ...(Array.isArray(desc.truncatedArrays) ? desc.truncatedArrays.map((t: any) => t?.field) : []),
  ].filter((p): p is string => typeof p === "string")
}

/** Whether every changed path is (or lies under) an ignored field. No path: false. */
export function onlyIgnoredPaths(paths: string[] | null, ignore: readonly string[]): boolean {
  if (!paths || !paths.length) return false
  return paths.every((p) => ignore.some((f) => p === f || p.startsWith(`${f}.`)))
}
