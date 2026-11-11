// What counts as a document to walk into — as opposed to a value to keep whole — for every part
// of mogobase that walks filters and expressions: watchInput's rewrites, filterKey, the matcher's
// embedded-document equality. A plain object: not an array, a Date, a RegExp, or a BSON value
// (ObjectId, Decimal128, Long, Binary, …, all marked by `_bsontype`). Three copies of this had
// drifted, and the one without the RegExp / BSON exclusions walked an ObjectId in a sync policy's
// $expr into { buffer: {…} } — a filter that never matched. Browser-safe: no imports.

export function isPlainDocument(value: unknown): value is Record<string, any> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    typeof (value as any)._bsontype !== "string"
  )
}
