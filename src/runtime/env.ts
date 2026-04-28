// Runtime environment detection. Browser-safe — no Node imports.
//
// `isServer` is true under Node (incl. the Next.js custom server, the API
// route worker, and SSR). `isClient` is its inverse — true in any browser
// context (DOM, service worker is treated as server because it has no
// `window`; that's intentional — handlers shouldn't run in SW).

export function isServer(): boolean {
  return typeof window === "undefined"
}

export function isClient(): boolean {
  return !isServer()
}
