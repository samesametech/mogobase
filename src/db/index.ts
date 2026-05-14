import { Collection, CreateIndexesOptions, Db, IndexDescription, MongoClient, ObjectId } from "mongodb"
import DataLoader from "dataloader"
import buildMongoFilters from "./buildMongoFilters"
import { onModel, TimeseriesOptions } from "@/runtime/models"

const DB_GLOBAL_KEY = "__mogobase_db__"
const dbGlobal = globalThis as unknown as Record<string, { instance?: MogobaseDB }>
if (!dbGlobal[DB_GLOBAL_KEY]) dbGlobal[DB_GLOBAL_KEY] = {}

type ResolverReturn = string | null | undefined
type RequestResolver = (ctx: { headers?: any }) => ResolverReturn | Promise<ResolverReturn>

type RawAliasDescriptor = { uri?: string; dbName: string }
type RegisteredAlias = { uri: string; dbName: string }

const DEFAULT_URI_FALLBACK = "mongodb://localhost:27017"
const DEFAULT_DB_FALLBACK = "mogobase"

function viewKey(uri: string, dbName: string): string {
  return `${uri}::${dbName}`
}

class MogobaseDB {
  static get _instance(): MogobaseDB {
    if (!dbGlobal[DB_GLOBAL_KEY].instance) {
      dbGlobal[DB_GLOBAL_KEY].instance = Object.create(MogobaseDB.prototype, {
        _schemas: { value: new Map(), writable: true, enumerable: true },
        _clients: { value: new Map(), writable: true, enumerable: true },
        _views: { value: new Map(), writable: true, enumerable: true },
        _rawAliases: { value: new Map(), writable: true, enumerable: true },
        _appliedModels: { value: new Map(), writable: true, enumerable: true },
      })
    }
    return dbGlobal[DB_GLOBAL_KEY].instance!
  }

  _mongoClient?: MongoClient
  _db?: Db
  _defaultUri?: string
  _defaultDbName?: string
  _schemas!: Map<string, any>
  _modelsBound?: boolean

  // Multi-database state. All shared via the singleton; views read from the
  // same maps so HMR-driven re-imports keep working.
  _clients!: Map<string /* uri */, MongoClient>
  _views!: Map<string /* uri::dbName */, MogobaseDB>
  _rawAliases!: Map<string /* alias */, RegisteredAlias>
  _appliedModels!: Map<string /* uri::dbName */, Set<string /* modelName */>>
  _resolver?: RequestResolver

  constructor() {
    return MogobaseDB._instance
  }

  async connect(): Promise<Db> {
    const MONGO_URI = process.env.MONGO_URI || DEFAULT_URI_FALLBACK
    const MONGO_DB = process.env.MONGO_DB || DEFAULT_DB_FALLBACK

    if (this._mongoClient && this._db) {
      return this._db
    }
    const client = await MongoClient.connect(MONGO_URI)
    this._mongoClient = client
    this._db = client.db(MONGO_DB)
    this._defaultUri = MONGO_URI
    this._defaultDbName = MONGO_DB
    this._clients.set(MONGO_URI, client)
    this._appliedModels.set(viewKey(MONGO_URI, MONGO_DB), new Set())

    if (!this._modelsBound) {
      this._modelsBound = true
      onModel((m) => {
        this.defineModel(m.name, m.schema, m.indexes, m.timeseries).catch((err) =>
          console.error(`[mogobase] failed to apply model ${m.name}`, err)
        )
      })
    }
    return this._db
  }

  async disconnect() {
    const closes: Promise<void>[] = []
    for (const client of this._clients.values()) {
      closes.push(client.close().catch((err) => console.warn("[mogobase] client close failed:", err)))
    }
    await Promise.all(closes)
    this._clients.clear()
    this._views.clear()
    this._appliedModels.clear()
    this._mongoClient = undefined
    this._db = undefined
  }

  get client(): MongoClient {
    if (!this._mongoClient) {
      throw new Error("Call connect() first")
    }
    return this._mongoClient
  }

  get db(): Db {
    if (!this._db) {
      throw new Error("Call connect() first")
    }
    return this._db
  }

  model(name: string): Collection {
    if (!this._db) {
      throw new Error("Call connect() first")
    }
    return this._db.collection(name)
  }

  async defineModel(
    name: string,
    schema?: any,
    indexes?: {
      indexSpecs: IndexDescription[]
      options?: CreateIndexesOptions
    },
    timeseries?: TimeseriesOptions
  ): Promise<Collection> {
    if (!this._db) {
      this._db = await this.connect()
    }
    const entry: any = {}
    if (schema) entry.schema = schema
    if (indexes) entry.indexes = indexes
    if (timeseries) entry.timeseries = timeseries
    if (schema || indexes || timeseries) {
      this._schemas.set(name, entry)
    }
    const collection = await this._applyModelToDb(this._db, name, entry)
    const key = viewKey(this._defaultUri ?? DEFAULT_URI_FALLBACK, this._defaultDbName ?? DEFAULT_DB_FALLBACK)
    let applied = this._appliedModels.get(key)
    if (!applied) {
      applied = new Set()
      this._appliedModels.set(key, applied)
    }
    applied.add(name)
    return collection
  }

  getSchema(name: string): { schema?: any; indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions }; timeseries?: TimeseriesOptions } | undefined {
    return this._schemas.get(name)
  }

  getSchemas(): Map<string, { schema?: any; indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions }; timeseries?: TimeseriesOptions }> {
    return this._schemas
  }

  // Apply a model's indexes (custom + sync-checkpoint) to a specific Db handle.
  // Mongo no-ops on duplicate index creates so this is safe to call repeatedly
  // across views.
  //
  // For timeseries models we additionally probe for the collection's existence
  // via listCollections (since `db.collection()` returns a handle whether or
  // not the collection has been materialized) and call createCollection with
  // the timeseries spec on first encounter. Sync-checkpoint auto-indexes are
  // skipped for timeseries — soft-delete semantics don't apply and the indexes
  // are not needed since sync is rejected for timeseries models.
  async _applyModelToDb(
    dbHandle: Db,
    name: string,
    entry: { schema?: any; indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions }; timeseries?: TimeseriesOptions }
  ): Promise<Collection> {
    let collection: Collection
    const ts = entry?.timeseries
    if (ts) {
      const existing = await dbHandle.listCollections({ name }, { nameOnly: true }).toArray()
      if (existing.length === 0) {
        const tsSpec: any = { timeField: ts.timeField }
        if (ts.metaField) tsSpec.metaField = ts.metaField
        if (ts.granularity) tsSpec.granularity = ts.granularity
        if (ts.bucketMaxSpanSeconds !== undefined) tsSpec.bucketMaxSpanSeconds = ts.bucketMaxSpanSeconds
        if (ts.bucketRoundingSeconds !== undefined) tsSpec.bucketRoundingSeconds = ts.bucketRoundingSeconds
        const createOpts: any = { timeseries: tsSpec }
        if (ts.expireAfterSeconds !== undefined) createOpts.expireAfterSeconds = ts.expireAfterSeconds
        try {
          collection = await dbHandle.createCollection(name, createOpts)
        } catch (err: any) {
          // If a non-timeseries collection of the same name already exists
          // listCollections might race; fall through to a regular handle and
          // let the warning below surface the mismatch.
          console.warn(`[mogobase] failed to create timeseries collection ${name}:`, err)
          collection = dbHandle.collection(name)
        }
      } else {
        collection = dbHandle.collection(name)
      }
    } else {
      collection = dbHandle.collection(name)
    }
    if (entry?.indexes) {
      try {
        await collection.createIndexes(entry.indexes.indexSpecs, entry.indexes.options)
      } catch (err) {
        console.warn(`[mogobase] failed to apply custom indexes for ${name}:`, err)
      }
    }
    if (!ts) {
      try {
        await collection.createIndexes([
          { key: { updatedAt: 1 }, name: "mogobase_updatedAt_1" },
          { key: { deletedAt: 1 }, name: "mogobase_deletedAt_1" },
          { key: { createdAt: 1 }, name: "mogobase_createdAt_1" },
        ])
      } catch (err) {
        console.warn(`[mogobase] failed to apply sync indexes for ${name}:`, err)
      }
    }
    return collection
  }

  // Schedule lazy index application for `name` against the given (uri, dbName)
  // pair. Fires once per (uri, dbName, name); subsequent calls are no-ops.
  // Fire-and-forget — `model(name)` stays sync. Mongo creates indexes
  // concurrently with writes so any race is benign.
  _ensureModelApplied(uri: string, dbName: string, dbHandle: Db, name: string): void {
    const key = viewKey(uri, dbName)
    let applied = this._appliedModels.get(key)
    if (!applied) {
      applied = new Set()
      this._appliedModels.set(key, applied)
    }
    if (applied.has(name)) return
    applied.add(name) // mark eagerly to avoid duplicate scheduling on bursts
    const entry = this._schemas.get(name)
    if (!entry) {
      // Model not registered with mogobase — still apply sync-checkpoint indexes
      // so writes through this view get correct indexing.
      this._applyModelToDb(dbHandle, name, {}).catch((err) =>
        console.warn(`[mogobase] lazy apply (no-schema) failed for ${name} on ${key}:`, err)
      )
      return
    }
    this._applyModelToDb(dbHandle, name, entry).catch((err) => {
      console.warn(`[mogobase] lazy apply failed for ${name} on ${key}:`, err)
      // Roll the marker back so a future call retries.
      applied!.delete(name)
    })
  }

  setRequestResolver(fn: RequestResolver | null): void {
    this._resolver = fn ?? undefined
  }

  registerDatabase(name: string, descriptor: RawAliasDescriptor): void {
    if (!name || !descriptor?.dbName) {
      throw new Error("registerDatabase requires a name and { dbName }")
    }
    if (this._rawAliases.has(name)) {
      throw new Error(`registerDatabase: alias "${name}" already registered`)
    }
    const uri = descriptor.uri ?? this._defaultUri ?? process.env.MONGO_URI ?? DEFAULT_URI_FALLBACK
    this._rawAliases.set(name, { uri, dbName: descriptor.dbName })
  }

  // Same-cluster switch. Returns a view that exposes the MogobaseDB surface
  // (`.model`, `.db`, `.client`, etc.) but is bound to a different db name.
  // Sync — relies on the default cluster being connected via connect().
  useDatabase(dbName: string): MogobaseDB {
    if (!dbName) throw new Error("useDatabase requires a dbName")
    if (!this._mongoClient || !this._defaultUri) {
      throw new Error("Call connect() first")
    }
    return this._getOrCreateView(this._defaultUri, dbName, this._mongoClient)
  }

  // Raw escape hatch. Async because it lazily connects the alias's cluster on
  // first use. Returns the native mongodb `Db` — no autoStamp, no model
  // registry, no index application.
  async useRawDatabase(name: string): Promise<Db> {
    const alias = this._rawAliases.get(name)
    if (!alias) {
      throw new Error(`useRawDatabase: alias "${name}" not registered. Call DB.registerDatabase("${name}", { uri, dbName }) at boot.`)
    }
    const client = await this._getOrConnectClient(alias.uri)
    return client.db(alias.dbName)
  }

  // Internal: run resolver, return active MogobaseDB for this request.
  // Returns the singleton itself if no resolver is registered or it returns
  // a falsy value.
  async _resolveActive(headers: any): Promise<MogobaseDB> {
    if (!this._resolver) return this
    let resolved: ResolverReturn
    try {
      resolved = await this._resolver({ headers })
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      console.error("[mogobase] DB resolver threw:", err)
      throw new Error(`[mogobase] DB resolver threw: ${msg}`)
    }
    if (!resolved) return this
    if (typeof resolved !== "string") {
      throw new Error("[mogobase] DB resolver returned unsupported value (expected string | null | undefined)")
    }
    return this.useDatabase(resolved)
  }

  private async _getOrConnectClient(uri: string): Promise<MongoClient> {
    let client = this._clients.get(uri)
    if (client) return client
    client = await MongoClient.connect(uri)
    this._clients.set(uri, client)
    return client
  }

  private _getOrCreateView(uri: string, dbName: string, client: MongoClient): MogobaseDB {
    const key = viewKey(uri, dbName)
    const cached = this._views.get(key)
    if (cached) return cached
    const view = new MogobaseDBView(this, client, client.db(dbName), uri, dbName) as unknown as MogobaseDB
    this._views.set(key, view)
    return view
  }
}

// View bound to (client, dbName). Schemas, raw aliases, applied-models cache,
// and resolver all live on the parent — the view delegates. The view is
// structurally compatible with MogobaseDB (same public surface) so handler
// ctx typing keeps working.
class MogobaseDBView {
  _mongoClient: MongoClient
  _db: Db
  _schemas: Map<string, any>
  private _parent: MogobaseDB
  private _uri: string
  private _dbName: string

  constructor(parent: MogobaseDB, client: MongoClient, db: Db, uri: string, dbName: string) {
    this._parent = parent
    this._mongoClient = client
    this._db = db
    this._schemas = parent._schemas
    this._uri = uri
    this._dbName = dbName
  }

  get client(): MongoClient {
    return this._mongoClient
  }

  get db(): Db {
    return this._db
  }

  model(name: string): Collection {
    this._parent._ensureModelApplied(this._uri, this._dbName, this._db, name)
    return this._db.collection(name)
  }

  // Defining a model on a view: register schema globally (so other views see
  // it too) and apply indexes immediately to this view's DB. Other views pick
  // it up lazily on first model() access.
  async defineModel(
    name: string,
    schema?: any,
    indexes?: {
      indexSpecs: IndexDescription[]
      options?: CreateIndexesOptions
    },
    timeseries?: TimeseriesOptions
  ): Promise<Collection> {
    const entry: any = {}
    if (schema) entry.schema = schema
    if (indexes) entry.indexes = indexes
    if (timeseries) entry.timeseries = timeseries
    if (schema || indexes || timeseries) {
      this._schemas.set(name, entry)
    }
    const collection = await this._parent._applyModelToDb(this._db, name, entry)
    const key = viewKey(this._uri, this._dbName)
    let applied = this._parent._appliedModels.get(key)
    if (!applied) {
      applied = new Set()
      this._parent._appliedModels.set(key, applied)
    }
    applied.add(name)
    return collection
  }

  getSchema(name: string) {
    return this._parent.getSchema(name)
  }

  getSchemas() {
    return this._parent.getSchemas()
  }

  // Views are pre-connected — no-op connect/disconnect.
  async connect(): Promise<Db> {
    return this._db
  }

  async disconnect(): Promise<void> {
    /* parent owns clients */
  }

  // Multi-DB methods on a view delegate to the parent so chains keep working.
  setRequestResolver(fn: RequestResolver | null): void {
    this._parent.setRequestResolver(fn)
  }

  registerDatabase(name: string, descriptor: RawAliasDescriptor): void {
    this._parent.registerDatabase(name, descriptor)
  }

  useDatabase(dbName: string): MogobaseDB {
    return this._parent.useDatabase(dbName)
  }

  useRawDatabase(name: string): Promise<Db> {
    return this._parent.useRawDatabase(name)
  }
}

export type { MogobaseDB }
export const Id = ObjectId
export const buildFilters = buildMongoFilters
export const DataLoaderGenerate = (model: string, key: string = "_id") => {
  const DB = new MogobaseDB()
  return new DataLoader(async (ids: readonly string[]) => {
    console.log("DataLoader", model, key, ids)
    const data = await DB.model(model)
      .find({
        [key]: {
          $in: ids.map((id) => new Id(id)),
        },
      })
      .toArray()

    return ids.map((id) => data.find((item) => `${item[key]}` === id))
  })
}

// Export singleton
export default new MogobaseDB()
