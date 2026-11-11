// One header shape for the DB resolver and the sync policy, whichever door a request came in by
// (review round 16). HTTP (the Next.js routes, hono.ts) passes a Fetch Headers, attachWs Node's
// IncomingHttpHeaders: a resolver reading headers["x-tenant"] found the tenant over the socket
// and nothing over HTTP, so mutations and sync silently went to the default database while
// queries read the tenant's. Both see headerView() now: plain lowercase keys, and get / has / …
import { afterEach, describe, expect, it, vi } from "vitest"
import DB from "@/db"
import { headerView } from "@/server/headers"
import { evaluateSyncPolicy } from "@/server/sync"

afterEach(() => {
  vi.restoreAllMocks()
  DB.setRequestResolver(null)
})

describe("headerView", () => {
  it("a Fetch Headers reads as Node's headers: keys, and a cookie list joined with \"; \"", () => {
    const view: any = headerView(new Headers([["X-Tenant", "t1"], ["cookie", "a=1"], ["cookie", "b=2"]]))
    expect(view["x-tenant"]).toBe("t1")
    expect(view.cookie).toBe("a=1; b=2") // as Node's Headers itself joins a cookie list
    expect(view.get("X-Tenant")).toBe("t1")
    expect({ ...view }).toEqual({ "x-tenant": "t1", cookie: "a=1; b=2" }) // the methods are not keys
  })

  it("Node's headers get the Fetch methods", () => {
    const view: any = headerView({ "x-tenant": "t1", "set-cookie": ["a=1", "b=2"] })
    expect(view.get("x-tenant")).toBe("t1")
    expect(view.has("X-TENANT")).toBe(true)
    expect(view.get("missing")).toBeNull()
    expect(new Headers(view).get("x-tenant")).toBe("t1")
  })

  // Rounds 16 and 18 asked in turn for the header and for the method here; the header won, since
  // the method in its place hid the header's value. Since round F12 the view is a real Headers,
  // whose list keeps every header: the method wins (round F13 — a client's `get` header made
  // every headers.get() on its socket throw), and the header is read with get(name).
  it("a header named like a method leaves the method; its value is read with get()", () => {
    const view: any = headerView(new Headers({ keys: "abc" }))
    expect(typeof view.keys).toBe("function")
    expect(view.get("keys")).toBe("abc")
  })

  it("null stays null; a view is not wrapped again", () => {
    expect(headerView(null)).toBeNull()
    const view = headerView({ a: "1" })
    expect(headerView(view)).toBe(view)
  })
})

describe("the resolver and the sync policy see one shape from every door", () => {
  it("a resolver reading headers[\"x-tenant\"] resolves a request that came in with a Fetch Headers (HTTP)", async () => {
    const useDatabase = vi.spyOn(DB, "useDatabase").mockReturnValue("tenant view" as any)
    DB.setRequestResolver(({ headers }) => headers?.["x-tenant"] ?? null)
    expect(await (DB as any)._resolveActive(new Headers({ "x-tenant": "t1" }))).toBe("tenant view")
    expect(useDatabase).toHaveBeenCalledWith("t1")
  })

  it("a resolver calling headers.get resolves a request that came in with Node's headers (attachWs)", async () => {
    const useDatabase = vi.spyOn(DB, "useDatabase").mockReturnValue("tenant view" as any)
    DB.setRequestResolver(({ headers }) => headers?.get?.("x-tenant") ?? null)
    expect(await (DB as any)._resolveActive({ "x-tenant": "t2" })).toBe("tenant view")
    expect(useDatabase).toHaveBeenCalledWith("t2")
  })

  it("a sync policy reading headers[\"authorization\"] works with a Fetch Headers", async () => {
    const policy = vi.fn(async ({ headers }: any) => ({ allow: headers.authorization === "Bearer x" }))
    expect((await evaluateSyncPolicy(policy, "pull", "m", new Headers({ Authorization: "Bearer x" }))).allow).toBe(true)
  })
})

describe("headerView: review round 17", () => {
  it("a cookie value holding \", \" is left as it is (round 16 rewrote it to \"; \", splitting the cookie)", () => {
    const view: any = headerView(new Headers({ cookie: "session=abc; pref=Mon, 01 Jan" }))
    expect(view.cookie).toBe("session=abc; pref=Mon, 01 Jan")
  })

  it("keeps getSetCookie, which the Fetch Headers (and ws.ts's view before) had", () => {
    const fetchView: any = headerView(new Headers([["set-cookie", "a=1"], ["set-cookie", "b=2"]]))
    expect(fetchView.getSetCookie()).toEqual(["a=1", "b=2"])
    const nodeView: any = headerView({ "set-cookie": ["a=1", "b=2"] })
    expect(nodeView.getSetCookie()).toEqual(["a=1", "b=2"])
    expect((headerView({}) as any).getSetCookie()).toEqual([])
  })

  it("a view is not wrapped again (a socket builds its own once; the transports pass that)", () => {
    const view = headerView({ "x-tenant": "t1" })
    expect(headerView(view)).toBe(view)
  })
})

describe("headerView: review round 18", () => {
  // Round 17 cached a view per headers object: a caller reusing one object — a job looping over
  // tenants, setting h["x-tenant"] each time — got the first tenant's view on every call, and
  // the resolver sent every iteration to that tenant's database.
  it("reads the headers as they are now, not as they were the first time", () => {
    const reused: Record<string, string> = { "x-tenant": "t1" }
    expect((headerView(reused) as any)["x-tenant"]).toBe("t1")
    reused["x-tenant"] = "t2"
    expect((headerView(reused) as any)["x-tenant"]).toBe("t2")
    const fetchReused = new Headers({ "x-tenant": "t1" })
    headerView(fetchReused)
    fetchReused.set("x-tenant", "t2")
    expect((headerView(fetchReused) as any).get("x-tenant")).toBe("t2")
  })

  it("keeps every Set-Cookie of a Fetch Headers, as Node keeps them (an array)", () => {
    const view: any = headerView(new Headers([["set-cookie", "a=1"], ["set-cookie", "b=2"]]))
    expect(view["set-cookie"]).toEqual(["a=1", "b=2"]) // was "b=2": forEach yields each on its own
    expect(view.get("set-cookie")).toBe("a=1, b=2")
  })
})

describe("headerView: review round 19", () => {
  it("getSetCookie answers from the snapshot, like every other read", () => {
    const source = new Headers([["set-cookie", "a=1"]])
    const view: any = headerView(source)
    source.append("set-cookie", "b=2")
    expect(view.getSetCookie()).toEqual(["a=1"]) // read the live source: ["a=1", "b=2"]
    expect(view.has("Set-Cookie")).toBe(true)
    expect(view.has("get")).toBe(false) // a method, not a header
  })
})

describe("headerView: review round F4", () => {
  it("get() reads header names only, not the object's prototype", () => {
    const view: any = headerView({ "x-a": "1" })
    expect(view.get("__proto__")).toBeNull() // was "[object Object]"
    expect(view.get("constructor")).toBeNull()
    expect(view.has("__proto__")).toBe(false)
  })
})

describe("headerView: review round F12", () => {
  // Before 4.0.0 the HTTP doors (hono.ts, the sync route template) and mogobase dev's ws.ts gave
  // the policy and the handlers the request's own Fetch Headers. The plain-object view broke an
  // auth helper that checks `instanceof Headers`, calls .append/.set, or builds a Request from
  // it: the session lookup failed and every sync pull and push was denied. The view is a real
  // Headers now — a copy — carrying the plain keys too.
  it("is a real Fetch Headers from every door, with the plain keys as well", () => {
    for (const source of [new Headers({ cookie: "s=1", "x-tenant": "t1" }), { cookie: "s=1", "x-tenant": "t1" }]) {
      const view: any = headerView(source)
      expect(view).toBeInstanceOf(Headers)
      expect(view.cookie).toBe("s=1")
      expect(view.get("Cookie")).toBe("s=1")
      expect(new Request("http://x/", { headers: view }).headers.get("x-tenant")).toBe("t1")
      expect({ ...view }).toEqual({ cookie: "s=1", "x-tenant": "t1" })
      view.set("x-tenant", "t2") // a copy: the source is untouched
      expect(source instanceof Headers ? source.get("x-tenant") : (source as any)["x-tenant"]).toBe("t1")
    }
  })

  it("a policy asked from an HTTP door gets a Headers instance", async () => {
    let seen: unknown
    await evaluateSyncPolicy(async ({ headers }) => ((seen = headers), { allow: true }), "pull", "m", new Headers({ cookie: "s=1" }))
    expect(seen).toBeInstanceOf(Headers)
  })

  it("a name or value Fetch refuses (an HTTP/2 pseudo-header) stays a plain key", () => {
    const view: any = headerView({ ":authority": "x.test", cookie: "s=1" })
    expect(view[":authority"]).toBe("x.test")
    expect(view.get("cookie")).toBe("s=1")
  })
})

describe("headerView: review round F13", () => {
  // Each header was copied into the Headers' list and onto an own property: after view.set or
  // view.delete the two disagreed — get("x-tenant") said t2 while headers["x-tenant"] still said
  // t1 — and attachWs passes one view to every run of a socket.
  it("the plain keys read the Headers' list: set, delete and a plain write stay in step", () => {
    const view: any = headerView({ "x-tenant": "t1", cookie: "a=1" })
    view.set("x-tenant", "t2")
    expect(view["x-tenant"]).toBe("t2")
    view.delete("cookie")
    expect(view.cookie).toBeUndefined()
    expect(view.has("cookie")).toBe(false)
    view["x-tenant"] = "t3"
    expect(view.get("x-tenant")).toBe("t3")
  })

  // A client sending a header named `get` (or toString) replaced the method: every
  // headers.get(...) on its socket threw (a denied sync, a failed resolver), and `${headers}`
  // in a logger threw too.
  it("a client's header named get or toString does not replace the method", () => {
    const view: any = headerView({ get: "x", tostring: "y", toString: "z", cookie: "a=1" })
    expect(view.get("cookie")).toBe("a=1")
    expect(view.get("get")).toBe("x")
    expect(() => `${view}`).not.toThrow()
  })
})

describe("copyHeaders (review round F16)", () => {
  it("copies a view — every Set-Cookie and a plain-only key included — and a write to the copy stays there", async () => {
    const { copyHeaders } = await import("@/server/headers")
    const view: any = headerView({ "x-tenant": "t1", "set-cookie": ["a=1", "b=2"], ":authority": "x.test" })
    const copy: any = copyHeaders(view)
    expect(copy).not.toBe(view)
    expect({ ...copy }).toEqual({ ...view })
    expect(copy.getSetCookie()).toEqual(["a=1", "b=2"])
    copy.set("x-tenant", "t2")
    expect(view.get("x-tenant")).toBe("t1")
  })
})

describe("headerView: round F21", () => {
  // A plain object's keys were lowercased and appended: { "X-Tenant": "a", "x-tenant": "b" } (a
  // default spread with an override) read "a, b", and the resolver named a database "a, b".
  it("of two keys differing only by case, the later wins", () => {
    const view: any = headerView({ "X-Tenant": "a", "x-tenant": "b" })
    expect(view.get("x-tenant")).toBe("b")
    expect(view["x-tenant"]).toBe("b")
  })
})
