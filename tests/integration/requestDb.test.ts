// The helpers both WebSocket transports share for the database a request reads and the
// default error text. The legacy ws.ts used to carry its own copies of both.

import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { getTestMongoUri } from "../helpers/mongo"
import DB from "@/db"
import { defaultFormatError, resolveRequestDb } from "@/server/requestDb"

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
})

afterEach(() => DB.setRequestResolver(null))

describe("resolveRequestDb", () => {
  it("the default database without a resolver, the resolved one with it", async () => {
    expect((await resolveRequestDb({})).db.databaseName).toBe("mogobase_test_integration")
    DB.setRequestResolver(({ headers }) => headers?.["x-tenant"] ?? null)
    expect((await resolveRequestDb({ "x-tenant": "tenant_rq" })).db.databaseName).toBe("tenant_rq")
    expect((await resolveRequestDb({})).db.databaseName).toBe("mogobase_test_integration")
  })
})

describe("defaultFormatError", () => {
  it("an error's message, or the value itself", () => {
    expect(defaultFormatError(new Error("Forbidden"))).toBe("Forbidden")
    expect(defaultFormatError("plain")).toBe("plain")
  })
})
