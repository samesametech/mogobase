// attachMogobaseWebSocket's numeric options are checked (review round F5): NaN — an unset
// environment variable — used to turn the heartbeat and backpressure off without a word.
import http from "http"
import { describe, expect, it, vi } from "vitest"
import { attachMogobaseWebSocket } from "@/server/attachWs"
import { numberOption } from "@/server/liveQuery"

describe("attachMogobaseWebSocket options", () => {
  it("heartbeatMs: NaN is the default 30 s heartbeat, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const interval = vi.spyOn(globalThis, "setInterval")
    const wss = attachMogobaseWebSocket(http.createServer(), "/ws", { heartbeatMs: NaN, maxBufferedBytes: NaN })
    expect(interval.mock.calls.some((c) => c[1] === 30_000)).toBe(true)
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/heartbeatMs[\s\S]*maxBufferedBytes|maxBufferedBytes[\s\S]*heartbeatMs/)
    await wss.stop()
    interval.mockRestore()
    warn.mockRestore()
  })

  it("numberOption: a number at least min passes (Infinity where allowed); anything else is the default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(numberOption("x", undefined, 5, 1)).toBe(5)
    expect(numberOption("x", 7, 5, 1)).toBe(7)
    expect(numberOption("x", Infinity, 5, 1)).toBe(Infinity)
    expect(numberOption("x", Infinity, 5, 0, false)).toBe(5)
    expect(numberOption("x", NaN, 5, 1)).toBe(5)
    expect(numberOption("x", 0, 5, 1)).toBe(5)
    expect(numberOption("x", 0, 5, 0)).toBe(0)
    expect(numberOption("x", "10", 5, 1)).toBe(5)
    warn.mockRestore()
  })
})
