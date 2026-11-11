// The HTTP sync route (hono.ts, `mogobase dev`) asks the policy as the WebSocket transports do,
// through evaluateSyncPolicy (review round 18): a policy that throws (its session store down) is
// a logged denial — 403 — not a 400 carrying the error's own text to the client.
import { afterEach, describe, expect, it, vi } from "vitest"
import app, { setHonoSyncPolicy } from "@/server/hono"

afterEach(() => {
  setHonoSyncPolicy(undefined)
  vi.restoreAllMocks()
})

describe("hono /api/sync and the sync policy", () => {
  it("a policy that throws denies with 403, and its message stays on the server", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    setHonoSyncPolicy(async () => {
      throw new Error("session store unreachable at 10.0.0.7")
    })
    for (const action of ["pull", "push"]) {
      const res = await app.request(`/api/sync?action=${action}`, { method: "POST", body: JSON.stringify({ model: "m", rows: [] }) })
      expect(res.status).toBe(403)
      expect(await res.text()).not.toContain("10.0.0.7")
    }
    expect(warn).toHaveBeenCalled()
  })
})
