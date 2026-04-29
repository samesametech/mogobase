import { MongoMemoryReplSet } from "mongodb-memory-server"

let replSet: MongoMemoryReplSet | undefined

export async function setup() {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    binary: { downloadDir: ".mongodb-binaries" },
  })
  process.env.MONGO_TEST_URI = replSet.getUri()
}

export async function teardown() {
  await replSet?.stop()
}
