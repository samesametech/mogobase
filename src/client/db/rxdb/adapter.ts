// Mongo-shaped adapter over an RxDB collection. Only the subset used by
// typical handler code — find/findOne/insertOne/updateOne/deleteOne/count — plus
// a cursor-like object for find() chaining.

import type { RxCollection, RxDocument } from "rxdb"

type MongoFilter = any
type MongoUpdate = any

function genId(): string {
  if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function stripMeta(doc: any): any {
  if (!doc || typeof doc !== "object") return doc
  const { _rev, _deleted, _attachments, _meta, ...rest } = doc
  return rest
}

function toSelector(filter: MongoFilter): any {
  // RxDB wraps the Mongo-style filter in `selector`. buildMongoFilters always
  // appends `deletedAt: null` — RxDB understands that directly.
  if (!filter || typeof filter !== "object") return {}
  return filter
}

function injectUpdatedAt(update: MongoUpdate, now: number): MongoUpdate {
  if (!update || typeof update !== "object") return { updatedAt: now }
  const hasOperators = Object.keys(update).some((k) => k.startsWith("$"))
  if (!hasOperators) return { ...update, updatedAt: now }
  return { ...update, $set: { ...(update.$set || {}), updatedAt: now } }
}

function applyUpdate(doc: any, update: MongoUpdate): any {
  // Support $set, $unset, $inc, $push, $pull. Bare updates (no $-operator) are
  // treated as a full replace merged with _id.
  if (!update || typeof update !== "object") return doc
  const hasOperators = Object.keys(update).some((k) => k.startsWith("$"))
  if (!hasOperators) return { ...update, _id: doc._id }

  const next = { ...doc }
  if (update.$set) Object.assign(next, update.$set)
  if (update.$unset) {
    for (const k of Object.keys(update.$unset)) delete (next as any)[k]
  }
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc as Record<string, number>)) {
      ;(next as any)[k] = ((next as any)[k] || 0) + v
    }
  }
  if (update.$push) {
    for (const [k, v] of Object.entries(update.$push as Record<string, any>)) {
      const arr = Array.isArray((next as any)[k]) ? [...(next as any)[k]] : []
      arr.push(v)
      ;(next as any)[k] = arr
    }
  }
  if (update.$pull) {
    for (const [k, v] of Object.entries(update.$pull as Record<string, any>)) {
      const arr = Array.isArray((next as any)[k]) ? (next as any)[k] : []
      ;(next as any)[k] = arr.filter((item: any) => item !== v && JSON.stringify(item) !== JSON.stringify(v))
    }
  }
  return next
}

class FindCursor {
  private _sort?: any
  private _skip?: number
  private _limit?: number

  constructor(private rx: RxCollection, private filter: MongoFilter) {}

  sort(spec: any) {
    this._sort = Array.isArray(spec) ? spec : spec
    return this
  }
  skip(n: number) {
    this._skip = n
    return this
  }
  limit(n: number) {
    this._limit = n
    return this
  }
  project(_p: any) {
    // RxDB doesn't support projection natively; ignored.
    return this
  }

  private buildQuery() {
    const q: any = { selector: toSelector(this.filter) }
    if (this._sort) {
      const arr = this._sort
      if (Array.isArray(arr)) q.sort = arr.map(([k, v]: any) => ({ [k]: v === 1 ? "asc" : "desc" }))
      else q.sort = Object.entries(arr).map(([k, v]: any) => ({ [k]: v === 1 ? "asc" : "desc" }))
    }
    if (typeof this._skip === "number") q.skip = this._skip
    if (typeof this._limit === "number") q.limit = this._limit
    return q
  }

  async toArray(): Promise<any[]> {
    const docs = await this.rx.find(this.buildQuery()).exec()
    return docs.map((d: RxDocument) => stripMeta(d.toJSON()))
  }

  async count(): Promise<number> {
    const docs = await this.rx.find(this.buildQuery()).exec()
    return docs.length
  }

  rxQuery() {
    return this.rx.find(this.buildQuery())
  }
}

export class RxMongoAdapter {
  constructor(public _rx: RxCollection, public name: string) {}

  find(filter: MongoFilter = {}) {
    return new FindCursor(this._rx, filter)
  }

  async findOne(filter: MongoFilter = {}): Promise<any | null> {
    const doc = await this._rx.findOne({ selector: toSelector(filter) }).exec()
    return doc ? stripMeta((doc as RxDocument).toJSON()) : null
  }

  async insertOne(doc: any): Promise<{ acknowledged: true; insertedId: string }> {
    const now = Date.now()
    const _id = doc._id || genId()
    const toInsert: any = {
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...doc,
      _id,
    }
    if (!toInsert.updatedAt) toInsert.updatedAt = now
    if (!toInsert.createdAt) toInsert.createdAt = now
    await this._rx.insert(toInsert)
    return { acknowledged: true, insertedId: _id }
  }

  async insertMany(docs: any[]): Promise<{ acknowledged: true; insertedIds: Record<number, string> }> {
    const now = Date.now()
    const ids: Record<number, string> = {}
    const toInsert = docs.map((d, i) => {
      const _id = d._id || genId()
      ids[i] = _id
      const next: any = {
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        ...d,
        _id,
      }
      if (!next.updatedAt) next.updatedAt = now
      if (!next.createdAt) next.createdAt = now
      return next
    })
    await this._rx.bulkInsert(toInsert)
    return { acknowledged: true, insertedIds: ids }
  }

  async updateOne(filter: MongoFilter, update: MongoUpdate) {
    const now = Date.now()
    const stamped = injectUpdatedAt(update, now)
    const doc = await this._rx.findOne({ selector: toSelector(filter) }).exec()
    if (!doc) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
    await (doc as RxDocument).incrementalModify((data: any) => applyUpdate(data, stamped))
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
  }

  async updateMany(filter: MongoFilter, update: MongoUpdate) {
    const now = Date.now()
    const stamped = injectUpdatedAt(update, now)
    const docs = await this._rx.find({ selector: toSelector(filter) }).exec()
    await Promise.all(
      docs.map((d: RxDocument) => d.incrementalModify((data: any) => applyUpdate(data, stamped)))
    )
    return { acknowledged: true, matchedCount: docs.length, modifiedCount: docs.length }
  }

  async deleteOne(filter: MongoFilter) {
    // Soft-delete to match server convention (buildMongoFilters appends deletedAt: null).
    const now = Date.now()
    const doc = await this._rx.findOne({ selector: toSelector(filter) }).exec()
    if (!doc) return { acknowledged: true, deletedCount: 0 }
    await (doc as RxDocument).incrementalModify((data: any) => ({
      ...data,
      deletedAt: now,
      updatedAt: now,
    }))
    return { acknowledged: true, deletedCount: 1 }
  }

  async deleteMany(filter: MongoFilter) {
    const docs = await this._rx.find({ selector: toSelector(filter) }).exec()
    const now = Date.now()
    await Promise.all(
      docs.map((d: RxDocument) =>
        d.incrementalModify((data: any) => ({ ...data, deletedAt: now, updatedAt: now }))
      )
    )
    return { acknowledged: true, deletedCount: docs.length }
  }

  async countDocuments(filter: MongoFilter = {}): Promise<number> {
    const docs = await this._rx.find({ selector: toSelector(filter) }).exec()
    return docs.length
  }

  async distinct(field: string, filter: MongoFilter = {}): Promise<any[]> {
    const docs = await this._rx.find({ selector: toSelector(filter) }).exec()
    const seen = new Set<any>()
    for (const d of docs) {
      const v = (d.toJSON() as any)[field]
      if (v !== undefined) seen.add(v)
    }
    return Array.from(seen)
  }

  // Hard-delete escape hatch.
  async hardDeleteOne(filter: MongoFilter) {
    const doc = await this._rx.findOne({ selector: toSelector(filter) }).exec()
    if (!doc) return { acknowledged: true, deletedCount: 0 }
    await (doc as RxDocument).remove()
    return { acknowledged: true, deletedCount: 1 }
  }
}
