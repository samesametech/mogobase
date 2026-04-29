// Deterministic JSON. Used to build cache keys for refetchScheduler so two
// queries with the same args (regardless of property iteration order) hit the
// same scheduler slot.

export function stableStringify(value: any): string {
  if (value === null) return "null"
  if (value === undefined) return "null"
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return String(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]"
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}"
  }
  return JSON.stringify(value)
}
