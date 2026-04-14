import { Collection, CreateIndexesOptions, Db, IndexDescription, MongoClient, ObjectId } from "mongodb"
import DataLoader from "dataloader"
import buildMongoFilters from "./buildMongoFilters"
import { onModel } from "@/runtime/models"

const DB_GLOBAL_KEY = "__mogobase_db__"
const dbGlobal = globalThis as unknown as Record<string, { instance?: MogobaseDB }>
if (!dbGlobal[DB_GLOBAL_KEY]) dbGlobal[DB_GLOBAL_KEY] = {}

class MogobaseDB {
  static get _instance(): MogobaseDB {
    if (!dbGlobal[DB_GLOBAL_KEY].instance) {
      dbGlobal[DB_GLOBAL_KEY].instance = Object.create(MogobaseDB.prototype, {
        _schemas: { value: new Map(), writable: true, enumerable: true },
      })
    }
    return dbGlobal[DB_GLOBAL_KEY].instance!
  }

  _mongoClient?: MongoClient
  _db?: Db
  _schemas!: Map<string, any>
  _modelsBound?: boolean

  constructor() {
    return MogobaseDB._instance
  }

  async connect(): Promise<Db> {
    const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017"
    const MONGO_DB = process.env.MONGO_DB || "mogobase"

    // Connect to MongoDB
    if (this._mongoClient && this._db) {
      return this._db
    }
    const client = await MongoClient.connect(MONGO_URI)
    this._mongoClient = client
    this._db = client.db(MONGO_DB)

    if (!this._modelsBound) {
      this._modelsBound = true
      onModel((m) => {
        this.defineModel(m.name, m.schema, m.indexes).catch((err) =>
          console.error(`[mogobase] failed to apply model ${m.name}`, err)
        )
      })
    }
    return this._db
  }

  async disconnect() {
    if (!this._mongoClient) return
    await this._mongoClient.close()
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
    }
  ): Promise<Collection> {
    if (!this._db) {
      this._db = await this.connect()
    }
    let collection = this._db.collection(name)
    if (!collection) {
      collection = await this._db.createCollection(name)
    }
    if (schema) {
      this._schemas.set(name, { schema, indexes })
    } else if (indexes) {
      this._schemas.set(name, { indexes })
    }
    if (indexes) {
      await collection.createIndexes(indexes.indexSpecs, indexes.options)
    }

    return collection
  }

  getSchema(name: string): { schema?: any; indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions } } | undefined {
    return this._schemas.get(name)
  }

  getSchemas(): Map<string, { schema?: any; indexes?: { indexSpecs: IndexDescription[]; options?: CreateIndexesOptions } }> {
    return this._schemas
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
