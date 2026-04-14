// Browser-side DB for mogobase offline mode. Backed by RxDB + Dexie (IndexedDB).
// Presents a MongoDB-shaped API via RxMongoAdapter so handler code written
// against mogobase/db works unchanged on the client.

import { createRxDatabase, addRxPlugin, type RxDatabase, type RxCollection } from "rxdb"
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie"
import { RxDBQueryBuilderPlugin } from "rxdb/plugins/query-builder"
import { RxDBUpdatePlugin } from "rxdb/plugins/update"
import { z } from "zod/v4"
import type z4 from "zod/v4"
import type { IndexDescription, CreateIndexesOptions } from "mongodb"

import { RxMongoAdapter } from "./adapter"

addRxPlugin(RxDBQueryBuilderPlugin)
addRxPlugin(RxDBUpdatePlugin)

type ModelDef = {
  schema?: any
  indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions }
}

const CDB_GLOBAL_KEY = "__mogobase_client_db__"
const cdbGlobal = globalThis as unknown as Record<string, { instance?: MogobaseClientDB }>
if (!cdbGlobal[CDB_GLOBAL_KEY]) cdbGlobal[CDB_GLOBAL_KEY] = {}

function isZodType(x: any): boolean {
  return !!x && typeof x === "object" && typeof x._def === "object" && typeof x.parse === "function"
}

function normalizeSchema(input: any): z4.ZodType {
  if (isZodType(input)) return input
  if (input && typeof input === "object") {
    // Plain shape object: { field: v.string(), ... } → wrap in z.object(...)
    return z.object(input as Record<string, z4.ZodType>) as unknown as z4.ZodType
  }
  return z.any() as unknown as z4.ZodType
}

function zodToRxJsonSchema(name: string, schemaInput: any, indexes?: ModelDef["indexes"]): any {
  const zodSchema = normalizeSchema(schemaInput)
  let json: any
  try {
    json = z.toJSONSchema(zodSchema as any, { target: "draft-7" })
  } catch (err) {
    console.warn(`[mogobase] toJSONSchema failed for ${name}, using open schema`, err)
    json = { type: "object", properties: {}, required: [] }
  }
  const base = json?.type === "object" ? json : { type: "object", properties: {}, required: [] }

  const properties = {
    _id: { type: "string", maxLength: 100 },
    deletedAt: { type: ["string", "null"] },
    ...(base.properties || {}),
  }
  const required = Array.from(new Set<string>([...(base.required || []), "_id"]))

  const rxIndexes: string[][] = []
  if (indexes?.indexSpecs) {
    for (const spec of indexes.indexSpecs) {
      const fields = Object.keys(spec.key || {})
      if (!fields.length) continue
      // RxDB supports simple field-name indexes; non-representable options are ignored.
      if (fields.length === 1) rxIndexes.push(fields)
      else rxIndexes.push(fields)
    }
  }

  return {
    title: name,
    version: 0,
    primaryKey: "_id",
    type: "object",
    properties,
    required,
    ...(rxIndexes.length ? { indexes: rxIndexes } : {}),
  }
}

export class MogobaseClientDB {
  static get _instance(): MogobaseClientDB {
    if (!cdbGlobal[CDB_GLOBAL_KEY].instance) {
      cdbGlobal[CDB_GLOBAL_KEY].instance = Object.create(MogobaseClientDB.prototype, {
        _schemas: { value: new Map(), writable: true, enumerable: true },
        _adapters: { value: new Map(), writable: true, enumerable: true },
      })
    }
    return cdbGlobal[CDB_GLOBAL_KEY].instance!
  }

  _rxdb?: RxDatabase
  _schemas!: Map<string, ModelDef>
  _adapters!: Map<string, RxMongoAdapter>
  _dbName: string = "mogobase"
  _connecting?: Promise<RxDatabase>

  constructor() {
    return MogobaseClientDB._instance
  }

  async connect(name?: string): Promise<RxDatabase> {
    if (this._rxdb) return this._rxdb
    if (this._connecting) return this._connecting
    if (name) this._dbName = name
    this._connecting = createRxDatabase({
      name: this._dbName,
      storage: getRxStorageDexie(),
    }).then((db) => {
      this._rxdb = db
      return db
    })
    return this._connecting
  }

  async disconnect() {
    if (!this._rxdb) return
    await this._rxdb.close()
    this._rxdb = undefined
    this._adapters.clear()
    this._connecting = undefined
  }

  async defineModel(
    name: string,
    schema?: any,
    indexes?: ModelDef["indexes"]
  ): Promise<RxMongoAdapter> {
    const db = await this.connect()
    this._schemas.set(name, { schema, indexes })
    if (!db.collections[name]) {
      const jsonSchema = schema
        ? zodToRxJsonSchema(name, schema, indexes)
        : {
            title: name,
            version: 0,
            primaryKey: "_id",
            type: "object",
            properties: { _id: { type: "string", maxLength: 100 }, deletedAt: { type: ["string", "null"] } },
            required: ["_id"],
          }
      await db.addCollections({ [name]: { schema: jsonSchema } })
    }
    const adapter = new RxMongoAdapter(db.collections[name] as RxCollection, name)
    this._adapters.set(name, adapter)
    return adapter
  }

  model(name: string): RxMongoAdapter {
    const a = this._adapters.get(name)
    if (!a) throw new Error(`Model ${name} not defined. Call defineModel("${name}", ...) first.`)
    return a
  }

  // Mirror server DB's getter names so handler code is portable.
  get db(): RxDatabase {
    if (!this._rxdb) throw new Error("Call connect() first")
    return this._rxdb
  }
}

export default new MogobaseClientDB()
