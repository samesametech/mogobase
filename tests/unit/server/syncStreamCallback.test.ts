// A hub "error" is informational (the hub keeps reconnecting): a sync stream does not make
// its client pull on it; a change or a "resync" does (review round 8).
import { describe, expect, it, vi } from "vitest"
import { subscribeSyncStream } from "@/server/sync"
import { defineModel } from "@/runtime/models"

defineModel("r8_synced", undefined, { sync: true })

describe("subscribeSyncStream on the hub", () => {
  it("pulls on a change or a resync, not on the hub's 'error'", async () => {
    let cb: ((doc: any, type: any) => void) | undefined
    const hub: any = { subscribe: async (_db: string, _m: string, _f: any, callback: any) => ((cb = callback), async () => {}) }
    const onEvent = vi.fn()
    await subscribeSyncStream(hub, "db", "r8_synced", onEvent)
    cb!(null, "error")
    expect(onEvent).not.toHaveBeenCalled()
    cb!({ _id: 1 }, "update")
    cb!(null, "resync")
    expect(onEvent).toHaveBeenCalledTimes(2)
  })
})
