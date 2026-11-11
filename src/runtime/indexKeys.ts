// How an index spec reads, for the registry (runtime/models: merging definitions' specs, warning
// on a conflict) and the database layer (db/indexes: matching specs against what MongoDB built) —
// one copy, so the two cannot disagree about which spec is which. Browser-safe: no imports (the
// registry is part of mogobase/runtime, which the offline hooks bundle).

// An index key is a plain object or a Map — the driver takes both, and a Map is how a caller
// pins the field order of a compound key. Reading a Map with Object.entries yields nothing, so
// a declared Map key matched no index: reported missing, and the real index undeclared — which
// dropUndeclaredIndexes would then have dropped.
export function keyEntries(key: unknown): [string, unknown][] {
  if (key instanceof Map) return [...key.entries()]
  return key && typeof key === "object" ? Object.entries(key as Record<string, unknown>) : []
}

/** An index spec's name: its own, or the one MongoDB generates (`a_1_b_-1`, `title_text`). */
export function indexName(spec: { name?: string; key?: unknown }): string {
  return spec.name ?? keyEntries(spec.key).map(([field, dir]) => `${field}_${dir}`).join("_")
}

/** A value as text with every object's keys sorted — an index option's identity, in any key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value) ?? String(value)
}
