import { MongoClient, Db } from "mongodb"

export function getTestMongoUri(): string {
  const uri = process.env.MONGO_TEST_URI
  if (!uri) throw new Error("MONGO_TEST_URI not set — run via vitest.integration.config.ts")
  return uri
}

export async function connectTestMongo(dbName = "mogobase_test"): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(getTestMongoUri())
  await client.connect()
  return { client, db: client.db(dbName) }
}

export async function cleanCollections(db: Db, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await db.collection(name).deleteMany({})
    } catch {}
  }
}
