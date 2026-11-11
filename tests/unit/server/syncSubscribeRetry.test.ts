// A sync-subscribe whose stream could not be opened — MongoDB unreachable as the client
// subscribed — was logged and dropped: the socket stayed up, so the client never subscribed
// again, and heard of no other device's write until its WebSocket reconnected (review round 14).
import { afterEach, describe, expect, it, vi } from "vitest"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { endSync, syncSubscribe, type SyncSocketState } from "@/server/syncMessages"

defineModel("r14_sync_retry", undefined, { sync: true })
defineModel("r14_not_synced")

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function harness(failures: number) {
  let calls = 0
  const unsubscribed: number[] = []
  const hub: any = {
    subscribe: async () => {
      const n = ++calls
      if (n <= failures) throw Object.assign(new Error("connection refused"), { name: "MongoNetworkError" })
      return async () => void unsubscribed.push(n)
    },
  }
  vi.spyOn(DB, "connect").mockResolvedValue(DB as any)
  vi.spyOn(DB, "db", "get").mockReturnValue({ databaseName: "r14db" } as any)
  vi.spyOn(console, "warn").mockImplementation(() => {})
  const own: SyncSocketState = {}
  const notified: string[] = []
  const start = (models: string[], policy?: any) =>
    syncSubscribe({ own, current: () => own, models, headers: {}, policy, hub, notify: (m) => notified.push(m), label: "test" })
  return { own, notified, unsubscribed, start, calls: () => calls }
}

describe("sync-subscribe: a stream that failed to open (review round 14)", () => {
  it("is tried again on the backoff, and the client told to pull once it is open", async () => {
    vi.useFakeTimers()
    const h = harness(2)
    await h.start(["r14_sync_retry"])
    expect(h.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 10)
    expect(h.calls()).toBe(3) // 1 s, then 2 s
    expect(h.notified).toEqual(["r14_sync_retry"]) // writes made while it was failing
    endSync(h.own)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.unsubscribed).toEqual([3]) // the late subscription is ended with the rest
  })

  it("stops trying once the socket's sync ends", async () => {
    vi.useFakeTimers()
    const h = harness(99)
    await h.start(["r14_sync_retry"])
    endSync(h.own)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.calls()).toBe(1)
  })

  it("does not retry a model that is not declared for sync", async () => {
    vi.useFakeTimers()
    const h = harness(0)
    await h.start(["r14_not_synced"])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.calls()).toBe(0)
  })
})

describe("sync-subscribe: the policy failing (review round 19)", () => {
  // evaluateSyncPolicy turns a throw into a denial — right for one request, but a sync-subscribe
  // denied that way was never asked again: a session store's blip at connect time left the
  // socket without live sync for its whole life. A throw is retried like a failed open; a policy
  // that answers allow: false is a refusal, and is not.
  it("a policy that throws is asked again on the backoff; once it allows, the stream opens and the client pulls", async () => {
    vi.useFakeTimers()
    let asked = 0
    const policy = async () => {
      if (++asked < 3) throw new Error("session store unreachable")
      return { allow: true }
    }
    const h = harness(0)
    await h.start(["r14_sync_retry"], policy)
    expect(h.calls()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 10)
    expect(asked).toBe(3)
    expect(h.calls()).toBe(1) // opened once the policy allowed it…
    expect(h.notified).toEqual(["r14_sync_retry"]) // …and the client pulls what it missed
    endSync(h.own)
  })

  it("a policy that answers allow: false, or nothing at all, is not asked again", async () => {
    vi.useFakeTimers()
    for (const answer of [{ allow: false }, undefined]) {
      let asked = 0
      const policy = async () => {
        asked++
        return answer as any
      }
      const h = harness(0)
      await h.start(["r14_sync_retry"], policy)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(asked).toBe(1)
      endSync(h.own)
    }
  })
})

describe("evaluateSyncPolicy (review round 19)", () => {
  it("a policy that resolves to nothing (a fallthrough with no return) is a logged denial, not a TypeError at every caller", async () => {
    const { evaluateSyncPolicy } = await import("@/server/sync")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await evaluateSyncPolicy((async () => undefined) as any, "pull", "m", {})).toEqual({ allow: false })
    expect(await evaluateSyncPolicy((async () => "yes") as any, "pull", "m", {})).toEqual({ allow: false })
  })
})

describe("sync-subscribe: the default-deny gate first (review round F11)", () => {
  // The policy (often a session-store read) was asked for every model a client listed, and the
  // gate refused a model not declared for sync only afterwards: a policy call wasted per model.
  it("a model not declared for sync, or a time-series one, is refused without asking the policy", async () => {
    defineModel("f11_series", undefined, { timeseries: { timeField: "at" } })
    let asked = 0
    const policy = async () => {
      asked++
      return { allow: true }
    }
    const h = harness(0)
    await h.start(["r14_not_synced", "f11_series"], policy)
    expect(asked).toBe(0)
    expect(h.calls()).toBe(0)
    endSync(h.own)
  })
})

describe("sync-subscribe: a policy filter a change stream cannot run (review round F12)", () => {
  // $where, $text and $near work in pull's find but MongoDB refuses them in a change stream's
  // $match: the model's stream of its own failed to open on every attempt and retried for good
  // (an aggregate per socket per model every ≤ 30 s), and its clients never heard of a write.
  // The stream is now left unnarrowed — a sync-stream frame names the model only, and each pull
  // still applies the filter — with a warning, once.
  it("streams the model unnarrowed on the shared hub, and says so once", async () => {
    const seen: unknown[] = []
    const h = harness(0)
    const hub = { subscribe: async (_db: string, _model: string, filter: unknown) => (seen.push(filter), async () => {}) }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const filter of [{ $where: "this.org === 'a'" }, { $and: [{ org: "a" }, { loc: { $near: [0, 0] } }] }, { $text: { $search: "a" } }]) {
      const own: SyncSocketState = {}
      await syncSubscribe({ own, current: () => own, models: ["r14_sync_retry"], headers: {}, policy: async () => ({ allow: true, filter }), hub: hub as any, notify: () => {}, label: "test" })
      endSync(own)
    }
    expect(seen).toEqual([undefined, undefined, undefined])
    expect(warn.mock.calls.filter((c) => /cannot run/.test(String(c[0]))).length).toBe(3) // one per operator
    void h
  })
})

describe("streamChanges: a stream that failed to open (review round F13)", () => {
  // streamChanges logged a failed subscribe and gave up: a model whose stream could not open as
  // it started (an election, a network blip) never streamed for the life of its cleanup
  // function. syncSubscribe, the other copy of this loop, retried. Both share one now.
  it("is tried again on the backoff, and the caller told once it is open; a refused model is not", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    let connects = 0
    vi.spyOn(DB, "connect").mockImplementation(async () => {
      if (++connects === 1) throw Object.assign(new Error("no primary"), { name: "MongoServerSelectionError" })
      return DB as any
    })
    vi.spyOn(DB, "db", "get").mockReturnValue({ databaseName: "r14db" } as any)
    const { streamChanges, syncHub } = await import("@/server/sync")
    const subscribe = vi.spyOn(syncHub(), "subscribe").mockImplementation(async () => async () => {})
    const events: string[] = []
    const stop = streamChanges(["r14_sync_retry"], (m) => events.push(m))
    await vi.advanceTimersByTimeAsync(10)
    expect(subscribe).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1100)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(events).toEqual(["r14_sync_retry"]) // writes made while it could not open
    stop()

    const refused = streamChanges(["r14_not_synced"], () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(subscribe).toHaveBeenCalledTimes(1)
    refused()
  })
})

describe("sync-subscribe: refusals are logged once (review round F14)", () => {
  // The model list comes from the client: every sync-subscribe logged a full warning, stack
  // included, for each model it listed that is not declared for sync — a client looping over
  // made-up names flooded the server's log. A refusal is logged once per model, as one line.
  it("logs a model's refusal once, without a stack, however often a client asks", async () => {
    defineModel("f14_not_synced")
    const h = harness(0)
    const warn = vi.mocked(console.warn)
    warn.mockClear()
    for (let i = 0; i < 3; i++) {
      await h.start(["f14_not_synced", "f14_made_up_a", "f14_made_up_b"])
      endSync(h.own)
    }
    const refusals = warn.mock.calls.filter((c) => /refused for (f14_not_synced|f14_made_up)/.test(String(c[0])))
    // The registered model once; the made-up names, one line for the minute.
    expect(refusals.map((c) => String(c[0]).match(/refused for (\w+)/)?.[1])).toEqual(["f14_not_synced", "f14_made_up_a"])
    expect(refusals.every((c) => c.length === 1)).toBe(true) // the message, not the error object
  })
})

describe("sync-subscribe: refusal logging cannot be used up (review round F15)", () => {
  // Round F14 logged at most 256 refused models, process-wide and for good: a client listing 256
  // made-up names used it up, and a real misconfiguration shipped later — a model whose
  // defineModel lacks sync: true — was refused with no log line at all (the client gets no frame).
  // A registered model is logged once (the app's own models bound it); names no defineModel
  // registered, which come from clients, at most one line a minute.
  it("a registered model's refusal is logged after any number of made-up names", async () => {
    const h = harness(0)
    const warn = vi.mocked(console.warn)
    await h.start(Array.from({ length: 300 }, (_, i) => `f15_noise_${i}`))
    endSync(h.own)
    warn.mockClear()
    defineModel("f15_forgot_sync")
    await h.start(["f15_forgot_sync"])
    expect(warn.mock.calls.filter((c) => /refused for f15_forgot_sync/.test(String(c[0])))).toHaveLength(1)
    endSync(h.own)
  })
})

describe("sync-subscribe: a policy that never answers (review round F15)", () => {
  // syncSubscribe stored its unsubscriber only once every model's first open had settled: one
  // model's policy hanging (a session store that never answers) left syncUnsub unset, so the
  // socket's close could not end the models already open — a hub subscription leaked per socket.
  it("the socket's close ends the models already open, while another model's policy hangs", async () => {
    defineModel("f15_hangs", undefined, { sync: true })
    const h = harness(0)
    const policy = async ({ model }: any) => (model === "f15_hangs" ? new Promise<never>(() => {}) : { allow: true })
    void h.start(["r14_sync_retry", "f15_hangs"], policy)
    await vi.waitFor(() => expect(h.calls()).toBe(1)) // r14_sync_retry is open
    endSync(h.own) // the socket closed
    await vi.waitFor(() => expect(h.unsubscribed).toEqual([1]))
  })
})
