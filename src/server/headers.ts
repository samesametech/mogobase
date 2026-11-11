// One request-header shape for the DB resolver and the sync policy, whichever door the request
// came in by. HTTP (the Next.js route templates, hono.ts) hands over a Fetch `Headers`; attachWs
// Node's IncomingHttpHeaders, a plain object. A resolver or policy written for one read nothing
// on the other — `headers["x-tenant"]` is undefined on a Headers, `headers.get` on a plain object
// — so a request could silently land in the default database, or be denied. No imports: the DB
// singleton uses it too.

const VIEW = Symbol.for("mogobase.headerView")

/**
 * Request headers as both shapes: a Fetch `Headers` (a copy: get / has / set / getSetCookie /
 * iteration, and `instanceof Headers`), carrying the plain lowercase keys Node's headers have.
 */
export type HeaderView = Headers & Record<string, string | string[] | undefined>

/**
 * `headers` as a HeaderView: a real Fetch `Headers` — a copy — with one enumerable lowercase key
 * per header, as Node's IncomingHttpHeaders has. A real Headers because, before 4.0.0, the HTTP
 * doors and mogobase dev's ws.ts gave the policy and the handlers the request's own Headers: an
 * auth helper checking `instanceof Headers`, calling .append, or building a Request from it failed
 * on a plain object, and every sync pull and push was denied (review round F12).
 *
 * The plain keys read and write the Headers' own list (round F13: copied beside it, they went
 * stale after a .set or .delete — and attachWs passes one view to every run of a socket). A
 * header's value is its get() string, as Node's (Node already joins a cookie list with "; "; a
 * cookie value holding ", " is left alone); set-cookie is its list, as Node keeps it. A header
 * named like a member of the Headers (get, keys, constructor — a client's own doing) leaves the
 * member alone and is read with get(name): in its place it made every headers.get() on its socket
 * throw (round F13; rounds 16 and 18 had weighed the header against the method when a method in
 * its place hid the header's value — the Headers' list keeps it now). A name or value Fetch
 * refuses (an HTTP/2 pseudo-header such as ":authority") is a plain key only. null / undefined /
 * a non-object as they are.
 *
 * A snapshot, built per call: not cached by the headers object, since a caller reusing one (a job
 * setting h["x-tenant"] per tenant) then got the first call's values every time (round 18). The
 * WebSocket transports build one per socket and pass that, which a later call returns as it is —
 * unless `copy`: each live-query run and each sync policy call gets its own (copyHeaders), so a
 * write to it stays with that run (round F16: a handler's ctx.headers.set reached every later run
 * on the socket, and the DB resolver).
 */
export function headerView(headers: unknown, copy = false): any {
  if (!headers || typeof headers !== "object") return headers
  const isView = !!(headers as any)[VIEW]
  if (isView && !copy) return headers
  const view = new Headers()
  const names: string[] = []
  const plainOnly = new Map<string, unknown>()
  const add = (name: string, value: unknown) => {
    try {
      for (const one of Array.isArray(value) ? value : [value]) view.append(name, String(one))
      if (!names.includes(name)) names.push(name)
    } catch {
      plainOnly.set(name, value) // a name or value Fetch refuses
    }
  }
  if (isFetchHeaders(headers)) {
    // Set-Cookie comes one entry per cookie: each appended, so getSetCookie() lists them all.
    headers.forEach((value: string, key: string) => add(key, value))
    // A view's own plain-only keys (names Fetch refused) are not in its list: copied too.
    if (isView) {
      for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(headers))) {
        if ("value" in desc && desc.enumerable) plainOnly.set(key, desc.value)
      }
    }
  } else {
    // Of two keys differing only by case, the later wins (Node's own headers never have two): added
    // up, { "X-Tenant": "a", "x-tenant": "b" } — a default spread with an override — read "a, b".
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value === undefined) continue
      const name = key.toLowerCase()
      if (names.includes(name)) view.delete(name)
      add(name, value)
    }
  }
  for (const name of names) {
    if (name in view) continue
    Object.defineProperty(view, name, {
      enumerable: true,
      configurable: true,
      get: () => (name === "set-cookie" ? view.getSetCookie() : (view.get(name) ?? undefined)),
      set: (value: unknown) => {
        view.delete(name)
        for (const one of value === undefined ? [] : Array.isArray(value) ? value : [value]) view.append(name, String(one))
      },
    })
  }
  for (const [name, value] of plainOnly) {
    if (!(name in view)) Object.defineProperty(view, name, { value, enumerable: true, writable: true, configurable: true })
  }
  Object.defineProperty(view, VIEW, { value: true, enumerable: false })
  return view
}

function isFetchHeaders(value: any): value is { forEach(cb: (value: string, key: string) => void): void } {
  return typeof value.get === "function" && typeof value.has === "function" && typeof value.forEach === "function"
}

/** A fresh copy of request headers as a HeaderView — a view too: what one run may write to. */
export function copyHeaders(headers: unknown): any {
  return headerView(headers, true)
}
