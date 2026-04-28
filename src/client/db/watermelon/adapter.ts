// Mongo-shaped adapter over a WatermelonDB table. Each model table has two
// columns — `data` (JSON blob of the full record) and `deleted_at` (soft-delete
// marker, indexed at the Loki layer). Queries prune deleted rows at the storage
// layer, then evaluate the rest of the Mongo filter in JS on decoded docs.
//
// Every mutation calls the injected `_broadcast` fn so peer tabs can replay it
// through `_applyUpsert` / `_applyHardDelete`. Remote-apply writes go through
// the same Watermelon write() path, which fires withChangesForTables and
// drives the receiving tab's hooks to refresh.

import { Database, Q } from "@nozbe/watermelondb"

import { applyUpdate, decodeRaw, genId, getPath, matches, MongoFilter, MongoUpdate } from "./filters"

export type CrossTabMsg =
  | { table: string; op: "upsert"; doc: any }
  | { table: string; op: "hardDelete"; id: string }

export type BroadcastFn = (msg: CrossTabMsg) => void

class FindCursor {
  private _sort?: any
  private _skip?: number
  private _limit?: number

  constructor(private wdb: Database, private tableName: string, private filter: MongoFilter) {}

  sort(spec: any) {
    this._sort = spec
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
    return this
  }

  private async fetchAll(): Promise<any[]> {
    const records: any[] = await this.wdb
      .get(this.tableName)
      .query(Q.where("deleted_at", null))
      .fetch()
    const docs = records.map((r) => decodeRaw((r as any)._raw))
    const filtered = docs.filter((d) => matches(d, this.filter))
    if (this._sort) {
      const entries = Array.isArray(this._sort)
        ? this._sort
        : Object.entries(this._sort).map(([k, v]) => [k, v])
      filtered.sort((a, b) => {
        for (const [k, dir] of entries as [string, any][]) {
          const av = getPath(a, k)
          const bv = getPath(b, k)
          if (av === bv) continue
          const cmp = av < bv ? -1 : 1
          return dir === 1 || dir === "asc" ? cmp : -cmp
        }
        return 0
      })
    }
    const start = this._skip || 0
    const end = typeof this._limit === "number" ? start + this._limit : undefined
    return filtered.slice(start, end)
  }

  async toArray(): Promise<any[]> {
    return this.fetchAll()
  }

  async count(): Promise<number> {
    return (await this.fetchAll()).length
  }
}

export class WatermelonMongoAdapter {
  constructor(
    public _wdb: Database,
    public name: string,
    private _broadcast: BroadcastFn = () => {}
  ) {}

  private coll() {
    return this._wdb.get(this.name)
  }

  find(filter: MongoFilter = {}) {
    return new FindCursor(this._wdb, this.name, filter)
  }

  async findOne(filter: MongoFilter = {}): Promise<any | null> {
    const out = await new FindCursor(this._wdb, this.name, filter).limit(1).toArray()
    return out[0] ?? null
  }

  async insertOne(doc: any): Promise<{ acknowledged: true; insertedId: string }> {
    const now = Date.now()
    const _id = doc._id || genId()
    const record: any = {
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...doc,
      _id,
    }
    if (!record.updatedAt) record.updatedAt = now
    if (!record.createdAt) record.createdAt = now
    await this._wdb.write(async () => {
      await this.coll().create((r: any) => {
        r._raw.id = _id
        r._raw.data = JSON.stringify(record)
        r._raw.deleted_at = null
      })
    })
    this._broadcast({ table: this.name, op: "upsert", doc: record })
    return { acknowledged: true, insertedId: _id }
  }

  async insertMany(docs: any[]): Promise<{ acknowledged: true; insertedIds: Record<number, string> }> {
    const now = Date.now()
    const ids: Record<number, string> = {}
    const records: any[] = []
    await this._wdb.write(async () => {
      const prepared = docs.map((d, i) => {
        const _id = d._id || genId()
        ids[i] = _id
        const record: any = {
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          ...d,
          _id,
        }
        if (!record.updatedAt) record.updatedAt = now
        if (!record.createdAt) record.createdAt = now
        records.push(record)
        return this.coll().prepareCreate((r: any) => {
          r._raw.id = _id
          r._raw.data = JSON.stringify(record)
          r._raw.deleted_at = null
        })
      })
      await this._wdb.batch(...prepared)
    })
    for (const r of records) this._broadcast({ table: this.name, op: "upsert", doc: r })
    return { acknowledged: true, insertedIds: ids }
  }

  async updateOne(filter: MongoFilter, update: MongoUpdate) {
    const target = await this.findOne(filter)
    if (!target) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
    const now = Date.now()
    const next = { ...applyUpdate(target, update), updatedAt: now }
    await this._wdb.write(async () => {
      const record = await this.coll().find(target._id)
      await record.update((r: any) => {
        r._raw.data = JSON.stringify(next)
        if (Object.prototype.hasOwnProperty.call(next, "deletedAt")) {
          r._raw.deleted_at = next.deletedAt ?? null
        }
      })
    })
    this._broadcast({ table: this.name, op: "upsert", doc: next })
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
  }

  async updateMany(filter: MongoFilter, update: MongoUpdate) {
    const targets = await this.find(filter).toArray()
    const now = Date.now()
    const nexts: any[] = []
    await this._wdb.write(async () => {
      const ops = await Promise.all(
        targets.map(async (t) => {
          const next = { ...applyUpdate(t, update), updatedAt: now }
          nexts.push(next)
          const record = await this.coll().find(t._id)
          return record.prepareUpdate((r: any) => {
            r._raw.data = JSON.stringify(next)
            if (Object.prototype.hasOwnProperty.call(next, "deletedAt")) {
              r._raw.deleted_at = next.deletedAt ?? null
            }
          })
        })
      )
      await this._wdb.batch(...ops)
    })
    for (const n of nexts) this._broadcast({ table: this.name, op: "upsert", doc: n })
    return { acknowledged: true, matchedCount: targets.length, modifiedCount: targets.length }
  }

  async deleteOne(filter: MongoFilter) {
    const target = await this.findOne(filter)
    if (!target) return { acknowledged: true, deletedCount: 0 }
    const now = Date.now()
    const next = { ...target, deletedAt: now, updatedAt: now }
    await this._wdb.write(async () => {
      const record = await this.coll().find(target._id)
      await record.update((r: any) => {
        r._raw.data = JSON.stringify(next)
        r._raw.deleted_at = now
      })
    })
    this._broadcast({ table: this.name, op: "upsert", doc: next })
    return { acknowledged: true, deletedCount: 1 }
  }

  async deleteMany(filter: MongoFilter) {
    const targets = await this.find(filter).toArray()
    const now = Date.now()
    const nexts: any[] = []
    await this._wdb.write(async () => {
      const ops = await Promise.all(
        targets.map(async (t) => {
          const next = { ...t, deletedAt: now, updatedAt: now }
          nexts.push(next)
          const record = await this.coll().find(t._id)
          return record.prepareUpdate((r: any) => {
            r._raw.data = JSON.stringify(next)
            r._raw.deleted_at = now
          })
        })
      )
      await this._wdb.batch(...ops)
    })
    for (const n of nexts) this._broadcast({ table: this.name, op: "upsert", doc: n })
    return { acknowledged: true, deletedCount: targets.length }
  }

  async countDocuments(filter: MongoFilter = {}): Promise<number> {
    return this.find(filter).count()
  }

  async distinct(field: string, filter: MongoFilter = {}): Promise<any[]> {
    const docs = await this.find(filter).toArray()
    const seen = new Set<any>()
    for (const d of docs) {
      const v = getPath(d, field)
      if (v !== undefined) seen.add(v)
    }
    return Array.from(seen)
  }

  async hardDeleteOne(filter: MongoFilter) {
    const target = await this.findOne(filter)
    if (!target) return { acknowledged: true, deletedCount: 0 }
    await this._wdb.write(async () => {
      const record = await this.coll().find(target._id)
      await record.destroyPermanently()
    })
    this._broadcast({ table: this.name, op: "hardDelete", id: target._id })
    return { acknowledged: true, deletedCount: 1 }
  }

  // Cross-tab receiver path. Looks up by id bypassing the soft-delete filter
  // so a soft-deleted-in-peer record can still be updated (its deletedAt
  // travels in the broadcast doc, and we set `deleted_at` accordingly).
  async _applyUpsert(doc: any) {
    const _id = doc._id
    if (!_id) return
    let existing: any = null
    try {
      existing = await this.coll().find(_id)
    } catch {
      // Not found; will create below.
    }
    await this._wdb.write(async () => {
      if (existing) {
        await existing.update((r: any) => {
          r._raw.data = JSON.stringify(doc)
          r._raw.deleted_at = doc.deletedAt ?? null
        })
      } else {
        await this.coll().create((r: any) => {
          r._raw.id = _id
          r._raw.data = JSON.stringify(doc)
          r._raw.deleted_at = doc.deletedAt ?? null
        })
      }
    })
  }

  async _applyHardDelete(id: string) {
    let record: any = null
    try {
      record = await this.coll().find(id)
    } catch {
      return
    }
    await this._wdb.write(async () => {
      await record.destroyPermanently()
    })
  }
}
