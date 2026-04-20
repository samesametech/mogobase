// Browser-side DB singleton for mogobase offline mode, backed by WatermelonDB
// + LokiJS. Alternative to the default RxDB/Dexie backend; selected via
//   <MogobaseProvider offlineAdapter="watermelon" ... />
//
// Storage strategy: one WatermelonDB table per model with three columns —
//   id (PK, mirrors _id), data (JSON blob of the full record), deleted_at.
// Mongo-style filters are evaluated in JS on the decoded blob (see ./filters),
// so consumer handler code written against mongodb works unchanged.
//
// Cross-tab reactivity: each tab has its own Loki in-memory state, so a write
// in tab A would otherwise be invisible to tab B until a page refresh (unlike
// RxDB which uses BroadcastChannel internally). This module broadcasts every
// mutation over a `BroadcastChannel` and applies incoming messages through a
// dedicated path that writes to the local Loki but skips re-broadcasting — the
// resulting Watermelon write triggers `withChangesForTables` in the receiving
// tab naturally, so `observeChanges` fires for its subscribers.

import { Database } from "@nozbe/watermelondb"
import Model from "@nozbe/watermelondb/Model"
import LokiJSAdapter from "@nozbe/watermelondb/adapters/lokijs"
import { appSchema, tableSchema } from "@nozbe/watermelondb"
import type { IndexDescription, CreateIndexesOptions } from "mongodb"

import { WatermelonMongoAdapter } from "./adapter"

type ModelDef = { schema?: any; indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions } }

export type CrossTabMsg =
  | { table: string; op: "upsert"; doc: any }
  | { table: string; op: "hardDelete"; id: string }

const CDB_GLOBAL_KEY = "__mogobase_watermelon_db__"
const cdbGlobal = globalThis as unknown as Record<string, { instance?: MogobaseWatermelonDB }>
if (!cdbGlobal[CDB_GLOBAL_KEY]) cdbGlobal[CDB_GLOBAL_KEY] = {}

function buildModelClass(name: string) {
  return class extends Model {
    static table = name
  }
}

export class MogobaseWatermelonDB {
  static get _instance(): MogobaseWatermelonDB {
    if (!cdbGlobal[CDB_GLOBAL_KEY].instance) {
      cdbGlobal[CDB_GLOBAL_KEY].instance = Object.create(MogobaseWatermelonDB.prototype, {
        _pending: { value: new Map(), writable: true, enumerable: true },
        _adapters: { value: new Map(), writable: true, enumerable: true },
      })
    }
    return cdbGlobal[CDB_GLOBAL_KEY].instance!
  }

  _wdb?: Database
  _pending!: Map<string, ModelDef>
  _adapters!: Map<string, WatermelonMongoAdapter>
  _dbName: string = "mogobase"
  _bc?: BroadcastChannel
  _applyingRemote = false

  constructor() {
    return MogobaseWatermelonDB._instance
  }

  async connect(name?: string): Promise<void> {
    if (name) this._dbName = name
    // Lazy — actual Database is built once all defineModel calls have run.
  }

  async defineModel(name: string, schema?: any, indexes?: ModelDef["indexes"]): Promise<void> {
    if (this._wdb && !this._pending.has(name)) {
      throw new Error(
        `[mogobase/watermelon] Cannot defineModel("${name}") after the offline DB has connected. ` +
          `All models must be registered before <MogobaseProvider> mounts. ` +
          `(WatermelonDB requires a fixed schema at Database construction.)`
      )
    }
    // Idempotent: re-registering a known model (e.g. React strict-mode double mount,
    // HMR) is a no-op. Only a NEW model after connect triggers the guard above.
    if (!this._pending.has(name)) this._pending.set(name, { schema, indexes })
  }

  private _ensureDb(): Database {
    if (this._wdb) return this._wdb
    if (this._pending.size === 0) {
      throw new Error(
        `[mogobase/watermelon] No models defined. Call defineModel() before accessing the DB.`
      )
    }
    const tables = Array.from(this._pending.keys()).map((name) =>
      tableSchema({
        name,
        columns: [
          { name: "data", type: "string" },
          { name: "deleted_at", type: "string", isOptional: true, isIndexed: true },
        ],
      })
    )
    const schema = appSchema({ version: 1, tables })
    const modelClasses = Array.from(this._pending.keys()).map((n) => buildModelClass(n))
    const adapter = new (LokiJSAdapter as any)({
      schema,
      useWebWorker: false,
      useIncrementalIndexedDB: true,
      dbName: this._dbName,
    })
    this._wdb = new Database({ adapter, modelClasses: modelClasses as any })
    const broadcast = (msg: CrossTabMsg) => this._broadcast(msg)
    for (const name of this._pending.keys()) {
      this._adapters.set(name, new WatermelonMongoAdapter(this._wdb, name, broadcast))
    }
    this._setupCrossTabSync()
    return this._wdb
  }

  private _setupCrossTabSync() {
    if (typeof BroadcastChannel === "undefined") return
    this._bc = new BroadcastChannel(`mogobase-watermelon-${this._dbName}`)
    this._bc.onmessage = async (ev: MessageEvent<CrossTabMsg>) => {
      const msg = ev.data
      const adapter = this._adapters.get(msg.table)
      if (!adapter) return
      this._applyingRemote = true
      try {
        if (msg.op === "upsert") {
          await adapter._applyUpsert(msg.doc)
        } else if (msg.op === "hardDelete") {
          await adapter._applyHardDelete(msg.id)
        }
      } catch (err) {
        console.warn("[mogobase/watermelon] remote apply failed", err)
      } finally {
        this._applyingRemote = false
      }
    }
  }

  _broadcast(msg: CrossTabMsg) {
    if (this._applyingRemote || !this._bc) return
    this._bc.postMessage(msg)
  }

  model(name: string): WatermelonMongoAdapter {
    this._ensureDb()
    const a = this._adapters.get(name)
    if (!a) throw new Error(`Model ${name} not defined. Call defineModel("${name}", ...) first.`)
    return a
  }

  observeChanges(name: string): { subscribe: (fn: () => void) => { unsubscribe: () => void } } {
    const wdb = this._ensureDb()
    return {
      subscribe: (fn: () => void) => {
        // withChangesForTables replays an initial value on subscribe — skip it
        // so useQuery doesn't re-run its fetch immediately on mount (which
        // would loop forever against the just-fetched state).
        let primed = false
        const sub = wdb.withChangesForTables([name]).subscribe(() => {
          if (!primed) {
            primed = true
            return
          }
          fn()
        })
        return { unsubscribe: () => sub.unsubscribe() }
      },
    }
  }

  get db(): Database {
    return this._ensureDb()
  }
}

export { WatermelonMongoAdapter } from "./adapter"

export default new MogobaseWatermelonDB()
