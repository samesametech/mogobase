// Where one ctx.watch() listens — decided once, for both transports (requestDb.watchTarget).
import { describe, expect, it } from "vitest"
import { watchTarget } from "@/server/requestDb"
import { defineModel } from "@/runtime/models"

const active: any = { db: { databaseName: "request_db" } }
defineModel("wt_homed", undefined, { databases: ["home_db"] })
defineModel("wt_plain")

describe("watchTarget", () => {
  it("the watch's own dbName, else the transport's override, else the one home, else the request's", () => {
    const override = (model: string) => (model === "wt_plain" ? "override_db" : null)
    expect(watchTarget("wt_homed", { dbName: "asked_db" }, active, override).dbName).toBe("asked_db")
    expect(watchTarget("wt_plain", undefined, active, override).dbName).toBe("override_db")
    expect(watchTarget("wt_homed", undefined, active, override).dbName).toBe("home_db")
    expect(watchTarget("wt_plain", undefined, active).dbName).toBe("request_db")
  })

  it("splits mogobase's options from the driver's", () => {
    const t = watchTarget("wt_plain", { dbName: "x", ignoreFields: ["a"], batchSize: 5 }, active)
    expect(t.driverOptions).toEqual({ batchSize: 5 })
    expect(t.ignoreFields).toEqual(["a", "updatedAt"])
  })
})
