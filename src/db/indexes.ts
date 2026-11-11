// Declared vs actual indexes for one collection. Pure — no driver calls — so the matching
// rules are testable on their own; MogobaseDB.diffIndexes feeds it `listIndexes()`.
//
// An index matches a declared spec by its KEY (fields, order and direction), not its name:
// a spec without a `name` gets MongoDB's generated one, and an app that renamed an index
// still has the index. A matched index whose options differ from the spec — unique,
// sparse, TTL, partial filter, or a name the spec insists on — is reported as conflicting:
// MongoDB refuses to build the spec over it, so the declared guarantee is not in force.

import type { Document, IndexDescription } from "mongodb"
import { stableStringify } from "@/server/stableStringify"
import { indexName, keyEntries } from "@/runtime/indexKeys"

// One reading of a spec's key and name for this module and the registry (runtime/indexKeys).
export { indexName, keyEntries }

export type IndexConflict = {
  declared: IndexDescription
  actual: Document
  /** The options that differ: "unique", "sparse", "expireAfterSeconds", "partialFilterExpression", "name". */
  differs: string[]
}

export type IndexDiff = {
  model: string
  dbName: string
  /** Whether the collection exists in that database. A missing one has no indexes at all yet. */
  exists?: boolean
  /** What mogobase builds for this model here: its `indexSpecs` plus the stamp indexes it keeps. */
  declared: IndexDescription[]
  /** `listIndexes()` — empty when the collection does not exist yet. */
  actual: Document[]
  /** Declared, with no index on that key. A failed or not-yet-run build. */
  missing: IndexDescription[]
  /** Declared, on that key, but with different options. */
  conflicting: IndexConflict[]
  /** In the database, declared by nothing (`_id_` excluded). What `dropUndeclaredIndexes` drops. */
  undeclared: Document[]
}

const isTextKey = (key: unknown) => keyEntries(key).some(([, dir]) => dir === "text")

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The one spec a failed createIndexes batch names in its error — "E11000 … index: email_1 dup
 * key", an options conflict on "a_1" — or undefined when it names none, or several. A name is
 * matched whole: "a_1" is not found inside "a_1_b_1".
 */
export function specNamedInError(error: unknown, specs: IndexDescription[]): IndexDescription | undefined {
  const text = `${(error as any)?.errmsg ?? ""} ${(error as any)?.message ?? ""}`
  // "Index already exists with a different name: a_1" names the index already there, not the spec
  // refused: an unnamed { a: 1 } spec (generated name a_1) was blamed, and the refused one built.
  if (/already exists with a different name/i.test(text)) return undefined
  const named = specs.filter((spec) => new RegExp(`(^|[^\\w.$-])${escapeRegExp(indexName(spec))}(?![\\w.$-])`).test(text))
  return named.length === 1 ? named[0] : undefined
}

function sameKey(a: unknown, b: unknown): boolean {
  const ea = keyEntries(a)
  const eb = keyEntries(b)
  if (ea.length !== eb.length) return false
  return ea.every(([field, dir], i) => {
    const [otherField, otherDir] = eb[i]
    if (field !== otherField) return false
    if (typeof dir === "string" || typeof otherDir === "string") return dir === otherDir
    return Number(dir) === Number(otherDir)
  })
}

// A declared text index ({ title: "text" }) lists as { _fts: "text", _ftsx: 1 }, and a
// collection holds at most one, so any text index on the collection is "that key"; which
// fields it covers is compared as an option ("weights").
// Its other key fields too: matched on the text alone, a compound { tenantId: 1, title: "text" }
// built by hand was reported as the declared { title: "text" }, which can never be built beside it.
function matchesKey(declared: IndexDescription, actual: Document): boolean {
  if (isTextKey(declared.key)) {
    if (actual.key?._fts !== "text") return false
    const plain = (entries: [string, unknown][]) => entries.filter(([field, dir]) => dir !== "text" && field !== "_fts" && field !== "_ftsx")
    return sameKey(new Map(plain(keyEntries(declared.key))), new Map(plain(keyEntries(actual.key))))
  }
  return sameKey(declared.key, actual.key)
}

// listIndexes returns a collation with every default filled in, so only the fields the spec
// states are compared. No collation on one side is the "simple" (binary) collation.
function collationDiffers(declared: Document | undefined, actual: Document | undefined): boolean {
  if (!declared) return !!actual && actual.locale !== "simple"
  if (!actual) return declared.locale !== "simple"
  return Object.entries(declared).some(([field, value]) => actual[field] !== value)
}

// The fields a text index covers, with their weights: a declared spec's "text" fields (weight
// 1 unless `weights` says otherwise), an actual index's `weights`.
function textWeights(declared: Document): Record<string, number> {
  const weights: Record<string, number> = {}
  for (const [field, dir] of keyEntries(declared.key)) if (dir === "text") weights[field] = 1
  for (const [field, weight] of Object.entries(declared.weights ?? {})) weights[field] = Number(weight)
  return weights
}

// `defaultCollation`: the collection's own, which an index declared without one is built with.
function optionDiffs(declared: IndexDescription, actual: Document, defaultCollation?: Document): string[] {
  const d = declared as Document
  const out: string[] = []
  if (!!d.unique !== !!actual.unique) out.push("unique")
  if (!!d.sparse !== !!actual.sparse) out.push("sparse")
  if ((d.expireAfterSeconds ?? null) !== (actual.expireAfterSeconds ?? null)) out.push("expireAfterSeconds")
  if (stableStringify(d.partialFilterExpression ?? null) !== stableStringify(actual.partialFilterExpression ?? null)) {
    out.push("partialFilterExpression")
  }
  if (collationDiffers(d.collation ?? defaultCollation, actual.collation)) out.push("collation")
  if (!!d.hidden !== !!actual.hidden) out.push("hidden")
  if (isTextKey(d.key)) {
    if (stableStringify(textWeights(d)) !== stableStringify(actual.weights ?? {})) out.push("weights")
    if (d.default_language !== undefined && d.default_language !== actual.default_language) out.push("default_language")
  }
  if (d.name && d.name !== actual.name) out.push("name")
  return out
}

/**
 * `tolerated`: keys that may exist without being declared or required — an index MongoDB
 * builds by itself, such as a time-series collection's `{ metaField, timeField }`.
 * `defaultCollation`: the collection's default collation, if it has one. An index declared
 * without a collation is built with it, so comparing against "simple" called every such index
 * conflicting, on every report.
 */
export function diffIndexSpecs(
  model: string,
  dbName: string,
  declared: IndexDescription[],
  actual: Document[],
  tolerated: IndexDescription[] = [],
  defaultCollation?: Document
): IndexDiff {
  const used = new Set<Document>()
  const missing: IndexDescription[] = []
  const conflicting: IndexConflict[] = []
  // MongoDB can hold two indexes on one key (unique and not, or different partial filters): the
  // one built from a spec is the one whose options agree with it. Every spec takes its exact match
  // of its own name first (its name, or the one MongoDB generates), then any exact match; only then
  // do the specs left take what is left on their key (a conflict). In one pass, a spec with no exact
  // match took the first index on its key, which could be a later spec's exact match: that spec was
  // then "missing" and the index "conflicting", the reverse of the truth. A spec left with nothing,
  // whose exact match another spec took, declares that index again: present, not missing.
  const exactFor = (spec: IndexDescription, a: Document) => matchesKey(spec, a) && optionDiffs(spec, a, defaultCollation).length === 0
  const exact = new Map<IndexDescription, Document>()
  for (const sameName of [true, false]) {
    for (const spec of declared) {
      if (exact.has(spec)) continue
      const match = actual.find((a) => !used.has(a) && exactFor(spec, a) && (!sameName || a.name === indexName(spec)))
      if (!match) continue
      used.add(match)
      exact.set(spec, match)
    }
  }
  for (const spec of declared) {
    if (exact.has(spec)) continue
    const candidates = actual.filter((a) => !used.has(a) && matchesKey(spec, a))
    const match = candidates.find((a) => spec.name !== undefined && a.name === spec.name) ?? candidates[0]
    if (!match) {
      if (!actual.some((a) => used.has(a) && exactFor(spec, a))) missing.push(spec)
      continue
    }
    used.add(match)
    conflicting.push({ declared: spec, actual: match, differs: optionDiffs(spec, match, defaultCollation) })
  }
  const undeclared = actual.filter(
    (a) => !used.has(a) && a.name !== "_id_" && !tolerated.some((t) => matchesKey(t, a))
  )
  return { model, dbName, declared, actual, missing, conflicting, undeclared }
}
