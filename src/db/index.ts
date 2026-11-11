import { headerView } from "@/server/headers"
import { Collection, CreateIndexesOptions, Db, Decimal128, IndexDescription, MongoClient, ObjectId } from "mongodb"
import DataLoader from "dataloader"
import buildMongoFilters from "./buildMongoFilters"
import {
  onModel,
  indexEnvelope,
  TimeseriesOptions,
  getModels,
  latestModelDef,
  latestModelDefs,
  getStampIndexFields,
  getModelDatabases,
  type StampIndexField,
} from "@/runtime/models"
import { diffIndexSpecs, specNamedInError, type IndexDiff } from "./indexes"
import { stableStringify } from "@/server/stableStringify"

const DB_GLOBAL_KEY = "__mogobase_db__"
const dbGlobal = globalThis as unknown as Record<
  string,
  { instance?: MogobaseDB; makeDecimal?: (s: string) => unknown }
>
if (!dbGlobal[DB_GLOBAL_KEY]) dbGlobal[DB_GLOBAL_KEY] = {}
// Publish the real BSON Decimal128 factory through the same server-only
// globalThis channel as the DB singleton. The browser-safe autoStamp wrapper
// reads this instead of `import { Decimal128 } from "mongodb"` — a static
// import there would drag mongodb's client-side-encryption (require
// "child_process") into the client bundle via handlers.ts → mogobase/runtime.
dbGlobal[DB_GLOBAL_KEY].makeDecimal = (s: string) => Decimal128.fromString(s)

type ResolverReturn = string | null | undefined
type RequestResolver = (ctx: { headers?: any }) => ResolverReturn | Promise<ResolverReturn>

type RawAliasDescriptor = { uri?: string; dbName: string }
type RegisteredAlias = { uri: string; dbName: string }
type ModelHomes = (model: string, dbName: string) => boolean | null | undefined

/**
 * Index builds mogobase could not complete. `spec` is the one that failed; `specs` lists every
 * spec the failure left unbuilt — just `[spec]` for a spec MongoDB refused, the whole batch for
 * a failure of the cluster (no primary, a lost connection), which is reported once.
 */
export type IndexErrorEvent = { model: string; dbName: string; spec: IndexDescription; specs: IndexDescription[]; error: unknown }
type IndexErrorListener = (event: IndexErrorEvent) => void
const INDEX_REPORT_CONCURRENCY = 8

/** `fn` over `items`, at most `limit` at a time; results in the items' order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
/** Retries of an index build that failed for the cluster's sake; reported at the first failure and if all fail. */
const INDEX_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000]
/** While a build retry is pending, a first use of the model builds again at most this often. */
const FIRST_USE_RETRY_GAP_MS = 1000
/** A delay ±25%: replicas that failed together (one election) must not retry in lockstep. */
export const jittered = (delay: number, random = Math.random()) => Math.round(delay * (0.75 + random * 0.5))

// A failure about the cluster rather than the specs — no primary, a lost connection, a
// shutdown, no privilege — fails every spec the same way.
const CLUSTER_ERROR_CODES = new Set([6, 7, 13, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436])
const CLUSTER_ERROR_NAMES = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoNotConnectedError",
  "MongoTopologyClosedError",
])
function isClusterError(err: any): boolean {
  if (!err) return false
  if (CLUSTER_ERROR_NAMES.has(err.name)) return true
  if (typeof err.hasErrorLabel === "function" && err.hasErrorLabel("RetryableWriteError")) return true
  return CLUSTER_ERROR_CODES.has(err.code)
}

const DEFAULT_URI_FALLBACK = "mongodb://localhost:27017"

// The URI connect() opens. One reading for every caller: a `??` in one copy where the others had
// `||` gave an alias the URI "" under MONGO_URI="" (round 16), and a copy that drifts from
// connect()'s makes _getOrConnectClient open a second client for it.
const defaultUri = (): string => process.env.MONGO_URI || DEFAULT_URI_FALLBACK
const DEFAULT_DB_FALLBACK = "mogobase"

function viewKey(uri: string, dbName: string): string {
  return `${uri}::${dbName}`
}

// The engine's stamp indexes. Names are fixed so they can be found, compared and dropped.
const STAMP_INDEX_SPECS: Record<StampIndexField, IndexDescription> = {
  updatedAt: { key: { updatedAt: 1 }, name: "mogobase_updatedAt_1" },
  deletedAt: { key: { deletedAt: 1 }, name: "mogobase_deletedAt_1" },
  createdAt: { key: { createdAt: 1 }, name: "mogobase_createdAt_1" },
}

/** The stamp indexes a model builds: all three unless its `stampIndexes` option turns some off. */
function stampIndexSpecs(name: string): IndexDescription[] {
  return getStampIndexFields(name).map((field) => STAMP_INDEX_SPECS[field])
}

const isNamespaceNotFound = (err: any) => err?.code === 26 || err?.codeName === "NamespaceNotFound"

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
  _modelHomes?: ModelHomes
  _indexErrorListeners?: Set<IndexErrorListener>
  /** Test hook: the cluster-failure retry backoff (default INDEX_RETRY_DELAYS_MS). */
  _indexRetryDelaysMs?: number[]
  /** Pending index-build retries, cancelled by disconnect(). Lazy: the singleton is built with Object.create. */
  _indexRetryTimers?: Set<ReturnType<typeof setTimeout>>
  /** Bumped by disconnect(): a build started under an earlier connection neither retries nor reports. */
  _connectionEpoch?: number
  /** Raw-alias connects in flight, per URI (see _getOrConnectClient). */
  _clientsConnecting?: Map<string, Promise<MongoClient>>
  /** The connect() in flight: concurrent callers share it (see connect). */
  _connecting?: Promise<Db>
  /** The disconnect() in flight: a connect() waits for it (see connect). */
  _disconnecting?: Promise<void>
  /** (database, model) pairs with a build retry pending: one retry chain each (see _buildMarked). */
  _pendingBuildRetries?: Set<string>
  /** When each such pair's build last failed: first uses rebuild at most once a second meanwhile. */
  _lastFailedBuild?: Map<string, number>

  constructor() {
    return MogobaseDB._instance
  }

  async connect(): Promise<Db> {
    // A disconnect() under way finishes first: joining it, a connect got the very client it was
    // about to close (its queries failed with "client was closed"). After it, a fresh one.
    if (this._disconnecting) await this._disconnecting.catch(() => {})
    if (this._mongoClient && this._db) {
      return this._db
    }
    // Concurrent callers share one connection. Each used to open its own client — at boot,
    // every socket's first message awaits connect() — the last one won, the rest leaked, and
    // after a disconnect each one replayed every model build.
    this._connecting ??= this._openConnection().finally(() => {
      this._connecting = undefined
    })
    return this._connecting
  }

  async _openConnection(): Promise<Db> {
    const MONGO_URI = defaultUri()
    const MONGO_DB = process.env.MONGO_DB || DEFAULT_DB_FALLBACK
    // A raw alias on this URI may have opened its client already (or be opening it): one client
    // per URI (see _getOrConnectClient).
    let client = this._clients.get(MONGO_URI)
    if (!client) client = await this._clientsConnecting?.get(MONGO_URI)?.catch(() => undefined)
    if (!client) client = await MongoClient.connect(MONGO_URI)
    this._mongoClient = client
    this._db = client.db(MONGO_DB)
    this._defaultUri = MONGO_URI
    this._defaultDbName = MONGO_DB
    this._clients.set(MONGO_URI, client)
    this._appliedModels.set(viewKey(MONGO_URI, MONGO_DB), new Set())

    const build = (m: ReturnType<typeof latestModelDefs>[number]) =>
      this.defineModel(m.name, m.schema, indexEnvelope(m), m.timeseries).catch((err) =>
        console.error(`[mogobase] failed to apply model ${m.name}`, err)
      )
    if (!this._modelsBound) {
      this._modelsBound = true
      // A model registered from now on is built as it comes — merged with its earlier
      // definitions, as the registry's getters read them (each field from the latest definition
      // that set it), so the database-level entry agrees with getModelOptions.
      let replaying = true
      onModel((m) => {
        if (replaying) return // onModel replays what is already registered: built just below
        // Only this model's definitions: re-merging every model per registration was O(N²).
        const merged = latestModelDef(m.name)
        if (merged) void build(merged)
      })
      replaying = false
    }
    // What is registered already — at the first connect, and again after disconnect(), which
    // cancelled the pending index retries and forgot what was built (nothing on the default
    // database builds lazily) — once per model, merged: replaying every definition ever made, in
    // parallel, rebuilt indexes a later definition had dropped.
    for (const m of latestModelDefs()) void build(m)
    return this._db
  }

  async disconnect(): Promise<void> {
    // Concurrent callers share one disconnect, and a connect() called meanwhile waits for it.
    this._disconnecting ??= this._closeConnection().finally(() => {
      this._disconnecting = undefined
    })
    return this._disconnecting
  }

  async _closeConnection(): Promise<void> {
    // A connect() still in flight finishes first, so its client is among the ones closed below.
    // Otherwise it landed after this, installed itself as the live connection and replayed
    // every model build on a client nobody would close.
    if (this._connecting) await this._connecting.catch(() => {})
    // Then, before awaiting the closes: a build that fails BECAUSE the client is closing
    // (MongoTopologyClosedError, mid-close) must already see the new epoch, or it reports an
    // index failure the disconnect caused. A pending retry holds the old client's collection
    // and would fail the same way; it is cancelled. The next connect() builds every registered
    // model again.
    this._connectionEpoch = (this._connectionEpoch ?? 0) + 1
    for (const timer of this._indexRetryTimers ?? []) clearTimeout(timer)
    this._indexRetryTimers?.clear()
    this._pendingBuildRetries?.clear()
    this._lastFailedBuild?.clear()
    this._clientsConnecting?.clear() // each closes its client on landing: see _getOrConnectClient
    // Forgotten BEFORE the closes are awaited: a connect() called meanwhile (a socket's message
    // during shutdown or a reload) opens a fresh client instead of taking the closing one, whose
    // queries then failed with "client was closed".
    const clients = [...this._clients.values()]
    this._clients.clear()
    this._views.clear()
    this._appliedModels.clear()
    this._mongoClient = undefined
    this._db = undefined
    // What they described too: the next connect() reads MONGO_URI / MONGO_DB again, and an alias
    // registered meanwhile takes the URI that connect() will use, not the closed one's.
    this._defaultUri = undefined
    this._defaultDbName = undefined
    await Promise.all(clients.map((client) => client.close().catch((err) => console.warn("[mogobase] client close failed:", err))))
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
    // connect() sets _db itself; writing it here again could put back a db a disconnect() had
    // just cleared.
    const db = this._db ?? (await this.connect())
    const uri = this._defaultUri ?? defaultUri()
    const defaultDbName = this._defaultDbName ?? DEFAULT_DB_FALLBACK
    return this._defineIn(uri, defaultDbName, db, name, schema, indexes, timeseries)
  }

  /**
   * defineModel, on the singleton or on a view: register the model, then build it in `dbName`
   * (if it lives there) and in the other databases its `databases` list names, in parallel.
   *
   * Every database it builds in is marked BEFORE the first build is awaited: a request touching
   * the model in one of them meanwhile would otherwise start a second, concurrent build there
   * (for a time-series model, a second createCollection that fails). A build that fails is
   * unmarked again, so the first use there builds it — as before the eager mark, and as a failed
   * lazy build does. Left marked, a time-series model whose probe failed was never created as
   * one: the first insert made a regular collection, which MongoDB cannot convert.
   */
  async _defineIn(
    uri: string,
    dbName: string,
    db: Db,
    name: string,
    schema?: any,
    indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions },
    timeseries?: TimeseriesOptions
  ): Promise<Collection> {
    const entry: any = {}
    if (schema) entry.schema = schema
    if (indexes) entry.indexes = indexes
    if (timeseries) entry.timeseries = timeseries
    if (schema || indexes || timeseries) {
      this._schemas.set(name, entry)
    }
    // Marked only where it lives, as _ensureModelApplied does: marked here regardless, a model
    // defined where it did not live yet was never built there once the rule said it did.
    const lives = this.livesIn(name, dbName)
    if (lives) this._markApplied(uri, dbName, name)
    const listed = this._buildListedDatabases(name, entry, [dbName])
    const [collection, listedCollections] = await Promise.all([
      lives ? this._buildMarked(uri, dbName, db, name, entry) : Promise.resolve(undefined),
      listed,
    ])
    if (collection) return collection
    // It does not live in this database: the handle returned is one where it does — its first
    // listed database. A handle on this one invited writes that made the very shadow collection
    // the `databases` option exists to prevent.
    const home = Array.isArray(listedCollections) ? listedCollections.find(Boolean) : undefined
    return (home as Collection | undefined) ?? db.collection(name)
  }

  /**
   * Build a model already marked applied in (uri, dbName); unmark it if the build fails. A
   * cluster failure (an election during a time-series probe) is built again on the index
   * retry backoff: unmarked alone, the default database never built it again, since its
   * model() has no lazy build — a time-series model was then born a regular collection.
   */
  _buildMarked(
    uri: string,
    dbName: string,
    db: Db,
    name: string,
    entry: any,
    attempt = 0,
    epoch = this._connectionEpoch ?? 0
  ): Promise<Collection> {
    const key = viewKey(uri, dbName)
    const retryKey = `${key}\u0000${name}`
    return this._applyModelToDb(db, name, entry, epoch).then((collection) => {
      this._lastFailedBuild?.delete(retryKey) // built: nothing left to throttle
      return collection
    }, (err) => {
      this._appliedModels.get(key)?.delete(name)
      if (isClusterError(err) && epoch === (this._connectionEpoch ?? 0)) {
        // One retry chain per (database, model). During an outage every request's first use of
        // the model (a view's lazy build) failed and started a chain of its own, so retries grew
        // with the request rate; a first use while one is pending starts none of its own (and
        // builds at most once a second: see _ensureModelApplied).
        const pending = (this._pendingBuildRetries ??= new Set())
        ;(this._lastFailedBuild ??= new Map()).set(retryKey, Date.now())
        if (attempt === 0 && pending.has(retryKey)) throw err
        pending.add(retryKey)
        const scheduled = this._scheduleRetry(attempt, () => {
          pending.delete(retryKey)
          if (this._appliedModels.get(key)?.has(name)) {
            this._lastFailedBuild?.delete(retryKey)
            return // built (or building) meanwhile
          }
          this._markApplied(uri, dbName, name)
          this._buildMarked(uri, dbName, db, name, entry, attempt + 1, epoch).catch((e) =>
            console.warn(`[mogobase] retried build of ${name} in ${dbName} failed:`, e)
          )
        })
        if (!scheduled) {
          // The backoff is spent: no chain left to throttle first uses for.
          pending.delete(retryKey)
          this._lastFailedBuild?.delete(retryKey)
        }
      }
      throw err
    })
  }

  /**
   * Run `retry` after attempt `attempt`'s backoff (INDEX_RETRY_DELAYS_MS, jittered by ±25% so
   * replicas that failed together do not retry together); false once the backoff is spent.
   * Tracked, so disconnect() cancels it.
   */
  _scheduleRetry(attempt: number, retry: () => void): boolean {
    const delay = (this._indexRetryDelaysMs ?? INDEX_RETRY_DELAYS_MS)[attempt]
    if (delay === undefined) return false
    const timers = (this._indexRetryTimers ??= new Set())
    const timer = setTimeout(() => {
      timers.delete(timer)
      retry()
    }, jittered(delay))
    timer.unref?.()
    timers.add(timer)
    return true
  }

  /**
   * Build a model in each database its `databases` list names (other than `skip`), now rather
   * than on first use — for a defineModel on the singleton or on a view alike. Every target is
   * marked built synchronously, before anything is awaited, so a request touching the model
   * there meanwhile does not start a second build; the builds run in parallel.
   */
  _buildListedDatabases(name: string, entry: any, skip: string[]): Promise<unknown> {
    const homes = getModelDatabases(name)
    if (!Array.isArray(homes) || !this._mongoClient || !this._defaultUri) return Promise.resolve()
    const uri = this._defaultUri
    const client = this._mongoClient
    const targets = [...new Set(homes)].filter((dbName) => !skip.includes(dbName))
    for (const dbName of targets) this._markApplied(uri, dbName, name)
    // A failure in one of these does not fail the defineModel that asked for its own database:
    // it is logged (and retried, if the cluster failed).
    return Promise.all(
      targets.map((dbName) => {
        const view = this._getOrCreateView(uri, dbName, client) as unknown as MogobaseDBView
        return this._buildMarked(uri, dbName, view.db, name, entry).catch((err) =>
          console.warn(`[mogobase] failed to build ${name} in ${dbName}:`, err)
        )
      })
    )
  }

  getSchema(name: string):
    | {
        schema?: any
        indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions }
        timeseries?: TimeseriesOptions
      }
    | undefined {
    return this._schemas.get(name)
  }

  getSchemas(): Map<
    string,
    {
      schema?: any
      indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions }
      timeseries?: TimeseriesOptions
    }
  > {
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
    entry: {
      schema?: any
      indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions }
      timeseries?: TimeseriesOptions
    },
    epoch = this._connectionEpoch ?? 0
  ): Promise<Collection> {
    // The connection this build started on; a disconnect() since closed its client. Every step
    // after one is skipped, unreported (the next connect() builds every model again): a step
    // started afterwards took the new epoch, so its failure against the closed client was
    // reported as an index failure, and its retry timer outlived the disconnect's clear.
    const stale = () => epoch !== (this._connectionEpoch ?? 0)
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
          if (stale()) return dbHandle.collection(name)
          if (err?.code === 48 || err?.codeName === "NamespaceExists") {
            // Created meanwhile. By a concurrent build of this model it is a time-series
            // collection, and all is well. By anything else (an insert that got there first) it
            // can be a regular one, which MongoDB cannot convert: that keeps the warning.
            const [found] = await dbHandle
              .listCollections({ name })
              .toArray()
              .catch(() => [] as any[])
            if (found && found.type !== "timeseries") {
              console.warn(`[mogobase] failed to create timeseries collection ${name}: a regular collection of that name was created first`, err)
            }
            collection = dbHandle.collection(name)
          } else {
            // A non-timeseries collection of the same name already exists (listCollections
            // might race); fall through to a regular handle and let the warning surface it.
            console.warn(`[mogobase] failed to create timeseries collection ${name}:`, err)
            collection = dbHandle.collection(name)
          }
        }
      } else {
        collection = dbHandle.collection(name)
      }
    } else {
      collection = dbHandle.collection(name)
    }
    if (stale()) return collection
    if (entry?.indexes) {
      await this._buildIndexes(dbHandle, collection, name, entry.indexes.indexSpecs, entry.indexes.options, "custom indexes", 0, epoch)
    }
    const stamps = ts ? [] : stampIndexSpecs(name)
    if (stamps.length && !stale()) await this._buildIndexes(dbHandle, collection, name, stamps, undefined, "sync indexes", 0, epoch)
    return collection
  }

  // Build the specs in one call. If MongoDB refuses the batch, build them one at a time: a
  // batch fails as a whole, so one bad spec — a TTL changed over an existing index, a unique
  // index over duplicates — used to keep every other spec of the model from being built.
  // Each spec that still fails is reported.
  async _buildIndexes(
    dbHandle: Db,
    collection: Collection,
    model: string,
    specs: IndexDescription[],
    options: CreateIndexesOptions | undefined,
    label: string,
    attempt = 0,
    epoch = this._connectionEpoch ?? 0
  ): Promise<void> {
    try {
      await collection.createIndexes(specs, options)
      return
    } catch (err) {
      if (epoch !== (this._connectionEpoch ?? 0)) return // disconnected meanwhile: see disconnect()
      // About the cluster, not the specs (no primary, a lost connection): each spec would fail
      // alike, so it is reported once for the whole batch — and retried later, on a backoff.
      // Without the retry, a build that ran during an election was never tried again: a lazy
      // build stays marked as done, so that database lacked the model's unique and TTL indexes
      // until the process restarted.
      if (isClusterError(err)) return this._retryIndexBuild(dbHandle, collection, model, specs, options, label, attempt, err, epoch)
      if (specs.length === 1) return this._reportIndexError(model, dbHandle.databaseName, specs, err, label)
      // The error names the spec it failed on (a duplicate key under a unique spec, an options
      // conflict): report that one and build the rest together — one more collection scan, not
      // one per spec, which is what a unique spec over duplicates cost on every boot.
      const culprit = specNamedInError(err, specs)
      if (culprit) {
        this._reportIndexError(model, dbHandle.databaseName, [culprit], err, label)
        const rest = specs.filter((spec) => spec !== culprit)
        return this._buildIndexes(dbHandle, collection, model, rest, options, label, attempt, epoch)
      }
    }
    for (let i = 0; i < specs.length; i++) {
      try {
        await collection.createIndexes([specs[i]], options)
      } catch (err) {
        // The cluster went away mid-loop (a failover): this spec and the ones after it were not
        // refused, only not built. Reported one by one and dropped, they stayed unbuilt — the
        // very bug the retry exists for. They are retried like a failed batch.
        if (epoch !== (this._connectionEpoch ?? 0)) return
        if (isClusterError(err)) {
          return this._retryIndexBuild(dbHandle, collection, model, specs.slice(i), options, label, attempt, err, epoch)
        }
        this._reportIndexError(model, dbHandle.databaseName, [specs[i]], err, label)
      }
    }
  }

  _retryIndexBuild(
    dbHandle: Db,
    collection: Collection,
    model: string,
    specs: IndexDescription[],
    options: CreateIndexesOptions | undefined,
    label: string,
    attempt: number,
    err: unknown,
    epoch: number
  ): void {
    const last = (this._indexRetryDelaysMs ?? INDEX_RETRY_DELAYS_MS)[attempt] === undefined
    if (attempt === 0 || last) this._reportIndexError(model, dbHandle.databaseName, specs, err, label)
    this._scheduleRetry(attempt, () => {
      void this._buildIndexes(dbHandle, collection, model, specs, options, label, attempt + 1, epoch).catch(() => {})
    })
  }

  _reportIndexError(model: string, dbName: string, specs: IndexDescription[], error: unknown, label: string): void {
    console.warn(`[mogobase] failed to apply ${label} for ${model}:`, error)
    for (const listener of this._indexErrorListeners ?? []) {
      try {
        listener({ model, dbName, spec: specs[0], specs, error })
      } catch (err) {
        console.warn("[mogobase] onIndexError listener threw:", err)
      }
    }
  }

  /**
   * Called for every index mogobase fails to build — at defineModel, or on a model's first
   * use in another database — with the model, the database, the spec and the error. A
   * failed build used to be a console warning and nothing else, so a collection could run
   * for months without its unique or TTL guarantee. Hook it to alerting. Returns an
   * unsubscribe. The warning is still logged.
   */
  onIndexError(listener: IndexErrorListener): () => void {
    const listeners = (this._indexErrorListeners ??= new Set())
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /**
   * `diffIndexes` for every registered model in every database it lives in. Databases
   * default to the default one plus every database mogobase has built a model in (or that
   * a model's `databases` list names); pass `dbNames` to choose. Models default to every
   * registered model. A collection that does not exist yet has `exists: false` — its
   * indexes are all `missing`, and are built on its first use.
   */
  async indexReport(opts: { dbNames?: string[]; models?: string[] } = {}): Promise<IndexDiff[]> {
    // Connect first, like defineModel: a migration script may call this before anything else.
    await this.connect()
    const models = opts.models ?? [...new Set([...getModels().map((m) => m.name), ...this._schemas.keys()])]
    const dbNames = opts.dbNames ?? this._knownDbNames(models)
    // Each listing is independent: run them a few at a time, not one after another — a report
    // over 50 models in 20 databases is a thousand round trips. Results keep their order.
    const pairs: [string, string][] = []
    for (const dbName of dbNames) for (const model of models) if (this.livesIn(model, dbName)) pairs.push([dbName, model])
    // Each database's collections once (their existence and default collation), not per model.
    // A few at a time, like the diffs below: a per-tenant app can know hundreds of databases.
    const toList = [...new Set(pairs.map(([dbName]) => dbName))]
    const infos = await mapLimit(toList, INDEX_REPORT_CONCURRENCY, (dbName) =>
      this._dbHandle(dbName).db.listCollections().toArray()
    )
    const listings = new Map(toList.map((dbName, i) => [dbName, new Map(infos[i].map((info: any) => [info.name, info]))]))
    return mapLimit(pairs, INDEX_REPORT_CONCURRENCY, ([dbName, model]) => this._diffIndexes(model, dbName, listings.get(dbName)))
  }

  _knownDbNames(models: string[]): string[] {
    const names = new Set<string>([this._defaultDbName ?? this.db.databaseName])
    // The same URI defineModel records applied models under (it falls back the same way).
    const prefix = `${this._defaultUri ?? defaultUri()}::`
    for (const key of this._appliedModels.keys()) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length))
    }
    for (const model of models) {
      const homes = getModelDatabases(model)
      if (Array.isArray(homes)) homes.forEach((name) => names.add(name))
    }
    return [...names]
  }

  _markApplied(uri: string, dbName: string, name: string): void {
    const key = viewKey(uri, dbName)
    let applied = this._appliedModels.get(key)
    if (!applied) {
      applied = new Set()
      this._appliedModels.set(key, applied)
    }
    applied.add(name)
  }

  /**
   * App-wide rule for which database(s) each model lives in: return true / false for a
   * (model, database) pair, or null / undefined for "no opinion" (every database, as before).
   * A model's own `databases` option wins over it. Set it BEFORE `DB.connect()`: models are
   * applied to the default database as they are bound at connect.
   */
  setModelDatabases(fn: ModelHomes | null): void {
    this._modelHomes = fn ?? undefined
  }

  /** Whether mogobase builds `model`'s indexes in `dbName` — its own `databases`, else the app rule, else yes. */
  livesIn(model: string, dbName: string): boolean {
    const own = getModelDatabases(model)
    if (Array.isArray(own)) return own.includes(dbName)
    if (typeof own === "function") return !!own(dbName)
    const rule = this._modelHomes?.(model, dbName)
    return typeof rule === "boolean" ? rule : true
  }

  // Schedule lazy index application for `name` against the given (uri, dbName)
  // pair. Fires once per (uri, dbName, name); subsequent calls are no-ops.
  // Fire-and-forget — `model(name)` stays sync. Mongo creates indexes
  // concurrently with writes so any race is benign.
  _ensureModelApplied(uri: string, dbName: string, dbHandle: Db, name: string): void {
    const key = viewKey(uri, dbName)
    if (this._appliedModels.get(key)?.has(name)) return
    // A build failed for the cluster's sake and its retry is pending: a first use still builds
    // (the cluster may be back), but at most once a second per (database, model) — during an
    // outage every request's first use built and failed, against a recovering primary.
    const retryKey = `${key}\u0000${name}`
    if (this._pendingBuildRetries?.has(retryKey) && Date.now() - (this._lastFailedBuild?.get(retryKey) ?? 0) < FIRST_USE_RETRY_GAP_MS) return
    // Not a database this model lives in: build nothing here, so no shadow collection appears —
    // and remember nothing, so a use after the rule says it lives here (setModelDatabases set
    // later, the declaring file loaded later) builds. Marked, it never did.
    if (!this.livesIn(name, dbName)) return
    this._markApplied(uri, dbName, name) // eagerly, so a burst of uses schedules one build
    // A model not registered with mogobase still gets the stamp indexes, so writes through this
    // view are indexed. Unmarked again if the build fails, so a later use retries.
    const entry = this._schemas.get(name)
    this._buildMarked(uri, dbName, dbHandle, name, entry ?? {}).catch((err) =>
      console.warn(`[mogobase] lazy apply${entry ? "" : " (no-schema)"} failed for ${name} on ${key}:`, err)
    )
  }

  // What mogobase builds for a model: its declared `indexSpecs`, plus the stamp indexes it
  // keeps (none for a time-series model).
  _declaredIndexes(name: string): IndexDescription[] {
    const entry = this._schemas.get(name)
    const custom: IndexDescription[] = entry?.indexes?.indexSpecs ?? []
    return [...custom, ...(entry?.timeseries ? [] : stampIndexSpecs(name))]
  }

  // Indexes MongoDB builds by itself, which are neither declared nor undeclared.
  _toleratedIndexes(name: string): IndexDescription[] {
    const ts: TimeseriesOptions | undefined = this._schemas.get(name)?.timeseries
    return ts?.metaField ? [{ key: { [ts.metaField]: 1, [ts.timeField]: 1 } }] : []
  }

  // A raw Db handle for a database on the default cluster. Not `.model()`, which would
  // schedule an index build there as a side effect.
  _dbHandle(dbName?: string): { db: Db; dbName: string } {
    const name = dbName || this._defaultDbName || this.db.databaseName
    if (name === this.db.databaseName) return { db: this.db, dbName: name }
    return { db: (this.useDatabase(name) as any).db as Db, dbName: name }
  }

  /**
   * A model's declared indexes against the ones a database actually has: `missing` (a
   * build that failed or has not run), `conflicting` (on the declared key, with other
   * options), `undeclared` (in the database, declared by nothing). Read-only.
   * `dbName` defaults to the default database.
   */
  async diffIndexes(model: string, opts: { dbName?: string } = {}): Promise<IndexDiff> {
    await this.connect()
    return this._diffIndexes(model, opts.dbName)
  }

  /**
   * diffIndexes, given (optionally) the database's collections by name from one
   * listCollections() — what indexReport passes, so a report over 50 models makes one listing
   * per database rather than one per model.
   */
  async _diffIndexes(model: string, dbNameIn?: string, collections?: Map<string, any>): Promise<IndexDiff> {
    const { db, dbName } = this._dbHandle(dbNameIn)
    // The indexes, and the collection's options (for its default collation, which an index
    // declared without one is built with) when indexReport did not list them — together: one
    // after the other they were two round trips per diff.
    const [listed, info] = await Promise.all([
      collections && !collections.has(model)
        ? undefined
        : db
            .collection(model)
            .listIndexes()
            .toArray()
            .catch((err: unknown) => {
              if (isNamespaceNotFound(err)) return undefined
              throw err
            }),
      collections ? collections.get(model) : db.listCollections({ name: model }).toArray().then(([found]) => found),
    ])
    const exists = listed !== undefined
    const actual: any[] = listed ?? []
    const defaultCollation = (info as any)?.options?.collation
    // A database the model does not live in declares nothing for it: any index there is undeclared.
    const declared = this.livesIn(model, dbName) ? this._declaredIndexes(model) : []
    return { ...diffIndexSpecs(model, dbName, declared, actual, this._toleratedIndexes(model), defaultCollation), exists }
  }

  /**
   * Drop the indexes a model no longer declares, in one database. Never called by mogobase
   * itself: an index stays until an app migration (or an operator) calls this. Everything
   * `diffIndexes` lists as `undeclared` goes — an engine stamp index the model opted out of,
   * a spec removed from `indexSpecs`, and ALSO any index created outside mogobase. List the
   * names to spare in `keep`, and run with `dryRun: true` first to see the list.
   * Conflicting indexes are never dropped.
   *
   * In a database the model does not live in (its `databases` option, `setModelDatabases`),
   * nothing is declared, so EVERY index there is undeclared — unique and TTL ones included,
   * on a collection that may belong to something else of the same name. A real drop there is
   * refused unless `shadow: true` says the collection is a shadow to clean up. A dry run is
   * always allowed.
   */
  async dropUndeclaredIndexes(
    model: string,
    opts: { dbName?: string; dryRun?: boolean; keep?: string[]; shadow?: boolean } = {}
  ): Promise<{ dbName: string; dropped: string[]; dryRun: boolean }> {
    const diff = await this.diffIndexes(model, { dbName: opts.dbName })
    const keep = new Set(opts.keep ?? [])
    const names = diff.undeclared.map((index) => index.name as string).filter((name) => !keep.has(name))
    const dryRun = opts.dryRun === true
    if (!dryRun && names.length && opts.shadow !== true && !this.livesIn(model, diff.dbName)) {
      throw new Error(
        `[mogobase] dropUndeclaredIndexes("${model}"): the model does not live in "${diff.dbName}", so every ` +
          `index there reads as undeclared (${names.join(", ")}). If that collection is a shadow to clean up, ` +
          `check it with { dryRun: true } and pass { shadow: true }.`
      )
    }
    if (dryRun) return { dbName: diff.dbName, dropped: names, dryRun }
    // Every one is tried, and the caller learns what went: a failure part-way used to throw
    // with nothing said about the indexes already dropped, and the rest never tried.
    const { db } = this._dbHandle(diff.dbName)
    const dropped: string[] = []
    const failed: { name: string; error: unknown }[] = []
    for (const name of names) {
      try {
        await db.collection(model).dropIndex(name)
        dropped.push(name)
      } catch (error) {
        // Already gone — dropped by another process meanwhile: what this call was for.
        if ((error as any)?.code === 27 || (error as any)?.codeName === "IndexNotFound") continue
        failed.push({ name, error })
      }
    }
    if (failed.length) {
      throw Object.assign(
        new Error(
          `[mogobase] dropUndeclaredIndexes("${model}") in "${diff.dbName}": could not drop ` +
            `${failed.map((f) => f.name).join(", ")}` +
            (dropped.length ? `; dropped ${dropped.join(", ")}` : "; dropped nothing")
        ),
        { dbName: diff.dbName, dropped, failed }
      )
    }
    return { dbName: diff.dbName, dropped, dryRun }
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
    const uri = descriptor.uri ?? this._defaultUri ?? defaultUri()
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
      throw new Error(
        `useRawDatabase: alias "${name}" not registered. Call DB.registerDatabase("${name}", { uri, dbName }) at boot.`
      )
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
      // One shape from every door (Fetch Headers over HTTP, Node's over attachWs): see headerView.
      resolved = await this._resolver({ headers: headerView(headers) })
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

  // One connect per URI, shared by every first use while it is in flight — two at once each
  // opened a client, and the one overwritten in `_clients` leaked its pool. A connect that
  // finishes after disconnect() is closed, not kept: added to the cleared map, it held the
  // process's connections open. connect() has had both since review round 8.
  private async _getOrConnectClient(uri: string): Promise<MongoClient> {
    const client = this._clients.get(uri)
    if (client) return client
    // One client per URI, shared with connect() on the default one (where an alias registered
    // without a uri lands): each used to keep its own in `_clients`, whichever came second
    // overwrote the other, and disconnect() never closed the one dropped — its pool kept the
    // process alive. A connect() opening this URI is waited for; otherwise the client is opened
    // here, and connect() takes it (_openConnection). Not by calling connect(): that builds every
    // registered model, which a raw alias — used by a boot script before the app's
    // setModelDatabases rule — must not set off.
    if (this._connecting && uri === defaultUri()) {
      await this._connecting.catch(() => {})
      const opened = this._clients.get(uri)
      if (opened) return opened
    }
    const pending = (this._clientsConnecting ??= new Map())
    let connecting = pending.get(uri)
    if (!connecting) {
      const epoch = this._connectionEpoch ?? 0
      connecting = MongoClient.connect(uri)
        .then(async (connected) => {
          if (epoch !== (this._connectionEpoch ?? 0)) {
            await connected.close().catch(() => {})
            throw new Error("[mogobase] disconnect() was called while a raw database's client was connecting")
          }
          this._clients.set(uri, connected)
          return connected
        })
        .finally(() => {
          if (pending.get(uri) === connecting) pending.delete(uri)
        })
      pending.set(uri, connecting)
    }
    return connecting
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
    return this._parent._defineIn(this._uri, this._dbName, this._db, name, schema, indexes, timeseries)
  }

  setModelDatabases(fn: ModelHomes | null): void {
    this._parent.setModelDatabases(fn)
  }

  livesIn(model: string, dbName: string): boolean {
    return this._parent.livesIn(model, dbName)
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

  // Index inspection on a view reads the view's database.
  diffIndexes(model: string, opts: { dbName?: string } = {}): Promise<IndexDiff> {
    // `opts.dbName ?? …`, not a spread over a default: an explicit `dbName: undefined` must not
    // turn a view's call into one on the default database.
    return this._parent.diffIndexes(model, { ...opts, dbName: opts.dbName ?? this._dbName })
  }

  dropUndeclaredIndexes(model: string, opts: { dbName?: string; dryRun?: boolean; keep?: string[]; shadow?: boolean } = {}) {
    return this._parent.dropUndeclaredIndexes(model, { ...opts, dbName: opts.dbName ?? this._dbName })
  }

  onIndexError(listener: IndexErrorListener): () => void {
    return this._parent.onIndexError(listener)
  }

  // Bound to the view's database, like the view's diffIndexes and dropUndeclaredIndexes.
  indexReport(opts: { dbNames?: string[]; models?: string[] } = {}): Promise<IndexDiff[]> {
    return this._parent.indexReport({ ...opts, dbNames: opts.dbNames ?? [this._dbName] })
  }
}

export type { MogobaseDB, IndexDiff }
export const Id = ObjectId
export const buildFilters = buildMongoFilters
const HEX24 = /^[0-9a-fA-F]{24}$/

// Batched lookups by `key`. Ids were all wrapped in `new ObjectId(id)`, which throws on
// anything that is not 24 hex characters — so a collection keyed by strings (a prefixed ULID
// such as `usr_01H…`) could not use it at all. Now a 24-hex string is looked up both as an
// ObjectId and as the string itself (a string `_id` can be 24 hex characters too), and any
// other id exactly as given. When both forms exist, the ObjectId wins — the only form a
// 24-hex id ever matched before, so a collection that held both reads as it always did.
export const DataLoaderGenerate = (model: string, key: string = "_id") => {
  const DB = new MogobaseDB()
  return new DataLoader(async (ids: readonly string[]) => {
    // Every batch's ids, on a hot path: opt-in only (MOGOBASE_DEBUG=1).
    if (process.env.MOGOBASE_DEBUG) console.log("DataLoader", model, key, ids)
    const values = ids.flatMap((id: any) => (typeof id === "string" && HEX24.test(id) ? [new Id(id), id] : [id]))
    const data = await DB.model(model)
      .find({
        [key]: {
          $in: values,
        },
      })
      .toArray()

    // One pass over the rows, not one per id, keyed by type as well as value (stableStringify,
    // the watch keys' format): the number 5 and the string "5" are different ids, and so are two
    // UUIDs whose bytes print alike. A 24-hex id is answered by the ObjectId row if there is
    // one, else by the string row. Of several rows with one value, the first wins.
    const byKey = new Map<string, any>()
    for (const item of data) {
      const k = stableStringify(item[key])
      if (!byKey.has(k)) byKey.set(k, item)
    }
    return ids.map((id: any) =>
      typeof id === "string" && HEX24.test(id)
        ? (byKey.get(stableStringify(new Id(id))) ?? byKey.get(stableStringify(id)))
        : byKey.get(stableStringify(id))
    )
  })
}

// Export singleton
export default new MogobaseDB()
