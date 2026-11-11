// useRawDatabase's client: one per URI even when first uses race, and none left open by a
// connect that finishes after disconnect() (review round 14 — connect() had both fixed, the
// raw-alias path had neither).
import { afterEach, describe, expect, it, vi } from "vitest"
import { MongoClient } from "mongodb"
import DB from "@/db"

afterEach(() => vi.restoreAllMocks())

function fakeConnect() {
  const made: any[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  vi.spyOn(MongoClient, "connect").mockImplementation((async () => {
    const client: any = { closed: false, db: (name: string) => ({ databaseName: name }), close: async () => void (client.closed = true) }
    made.push(client)
    await gate
    return client
  }) as any)
  return { made, release }
}

describe("raw database clients (review round 14)", () => {
  it("two first uses of a cold alias at once share one client", async () => {
    const { made, release } = fakeConnect()
    DB.registerDatabase("r14_raw_a", { uri: "mongodb://r14-raw-a", dbName: "analytics" })
    const both = Promise.all([DB.useRawDatabase("r14_raw_a"), DB.useRawDatabase("r14_raw_a")])
    release()
    const [a, b] = await both
    expect(made).toHaveLength(1) // was 2: the first overwritten in the map, its pool leaked
    expect(a).toEqual(b)
  })

  it("a connect that finishes after disconnect() is closed, not kept", async () => {
    const { made, release } = fakeConnect()
    DB.registerDatabase("r14_raw_b", { uri: "mongodb://r14-raw-b", dbName: "analytics" })
    const using = DB.useRawDatabase("r14_raw_b").catch((e) => e)
    await vi.waitFor(() => expect(made).toHaveLength(1))
    await DB.disconnect()
    release()
    expect(await using).toBeInstanceOf(Error)
    expect(made[0].closed).toBe(true)
    expect((DB as any)._clients.has("mongodb://r14-raw-b")).toBe(false)
  })
})

describe("a raw alias on the default URI (review round 15)", () => {
  // connect() and useRawDatabase each kept their own client for the same URI in `_clients`:
  // whichever came second overwrote the other, and disconnect() never closed the one dropped —
  // its pool kept the process alive. On the default URI the alias now uses connect()'s client.
  it("shares connect()'s client, whichever comes first, and disconnect() closes it", async () => {
    const made: any[] = []
    vi.spyOn(MongoClient, "connect").mockImplementation((async () => {
      const client: any = { closed: false, db: (name: string) => ({ databaseName: name }), close: async () => void (client.closed = true) }
      made.push(client)
      return client
    }) as any)
    const saved = process.env.MONGO_URI
    process.env.MONGO_URI = "mongodb://r15-default"
    try {
      DB.registerDatabase("r15_same_uri", { dbName: "analytics" }) // no uri: the default one
      await DB.useRawDatabase("r15_same_uri") // before connect(), as a boot script might
      await DB.connect()
      expect(made).toHaveLength(1)
      await DB.disconnect()
      expect(made.every((c) => c.closed)).toBe(true)
    } finally {
      process.env.MONGO_URI = saved
    }
  })
})

describe("a raw alias on the default URI (review round 16)", () => {
  // Round 15 sent it through connect(), which builds every registered model — before an app's
  // setModelDatabases rule, as a boot script calling useRawDatabase first would, that built
  // collections the rule exists to keep out. A raw alias opens a client and nothing else.
  it("does not build models; connect() afterwards still shares its client", async () => {
    const made: any[] = []
    vi.spyOn(MongoClient, "connect").mockImplementation((async () => {
      const client: any = { closed: false, db: (name: string) => ({ databaseName: name }), close: async () => void (client.closed = true) }
      made.push(client)
      return client
    }) as any)
    const opened = vi.spyOn(DB as any, "_openConnection")
    const saved = process.env.MONGO_URI
    process.env.MONGO_URI = "mongodb://r16-default"
    try {
      DB.registerDatabase("r16_same_uri", { dbName: "analytics" })
      await DB.useRawDatabase("r16_same_uri")
      expect(opened).not.toHaveBeenCalled() // no connect(), so no model builds
      await DB.connect()
      expect(made).toHaveLength(1)
      await DB.disconnect()
      expect(made.every((c) => c.closed)).toBe(true)
    } finally {
      process.env.MONGO_URI = saved
    }
  })

  it("an empty MONGO_URI falls back the same way for an alias as for connect()", async () => {
    const saved = process.env.MONGO_URI
    process.env.MONGO_URI = ""
    try {
      DB.registerDatabase("r16_empty_uri", { dbName: "x" })
      expect((DB as any)._rawAliases.get("r16_empty_uri").uri).toBe("mongodb://localhost:27017")
    } finally {
      process.env.MONGO_URI = saved
    }
  })
})
