# Sync Mode (Local-First)

Mogobase has three runtime modes:

| Provider props                                   | Reads / writes go through       | Server contact                |
| ------------------------------------------------ | ------------------------------- | ----------------------------- |
| `online={true}`                                  | WebSocket / `/api/handlers`     | every read & write            |
| `online={false}` + `clientDB`                    | clientDB (RxDB or Watermelon)   | none                          |
| `online={true}` + `sync={true}` + `clientDB`     | clientDB                        | continuous background sync    |

This guide covers the third mode.

## Enabling sync (client)

```tsx
"use client"
import MogobaseProvider from "mogobase/provider"
import RxClientDB from "mogobase/client-db" // or "mogobase/client-db/watermelon"

const syncOptions = {} // module-scope or useMemo — see "Stability" below

export default function Layout({ children }) {
  return (
    <MogobaseProvider
      online={true}
      sync={true}
      clientDB={RxClientDB}
      syncOptions={syncOptions}
      handlers={() => import("@/mogobase")}
    >
      {children}
    </MogobaseProvider>
  )
}
```

Behavior:

- `useQuery` / `usePaginatedQuery` always read from `clientDB` (no WS query
  channel is opened for these hooks). They re-run on `clientDB.observeChanges()`
  events.
- `useMutation` always writes to `clientDB`. The sync engine batches and
  forwards writes to MongoDB.
- A background engine pushes incoming server changes (via the `/ws`
  change-stream) into `clientDB` and pushes local writes up to MongoDB.

## Security model

Three layers, all enforced server-side. Pick the ones you need; defaults are
secure (default-deny).

### 1. Default-deny model allowlist

A model is syncable only when `defineModel(...)` opts in:

```ts
import { defineModel, v } from "mogobase/runtime"

defineModel(
  "posts",
  v.object({ title: v.string(), userId: v.string() }),
  { sync: true }
)
```

Pull/push/watch for any model without `sync: true` throws `Model "<name>" is
not configured for sync`. This includes models registered for online-only
handlers — no model is silently exposed to the sync transport.

### 2. Field-level allowlist (`clientFields`)

`clientFields` defines which document fields are visible to clients. It
applies to both the sync engine **and** online handler return values via
`filterClientFields(model, doc)` (see `mogobase://guide/handlers`).

```ts
defineModel("posts", schema, {
  clientFields: ["title", "content", "categoryId", "userId"],
  sync: true,
})
```

What it does:

- **Sync pull** projects each doc to `clientFields ∪ engine fields` so server-
  only fields (audit columns, internal flags, soft-delete metadata you don't
  want shipped) never reach the client store.
- **Sync push** strips incoming docs to the same allowlist before storage.
  Clients can't write `role`, `createdBy`, `isInternal`, etc. — those keys are
  silently dropped.
- Engine fields are always included regardless of allowlist:
  `_id`, `createdAt`, `updatedAt`, `deletedAt` (plus `_deleted` on push).
- Omitting `clientFields` means no field restriction (every field is visible
  and writable).

`clientFields` and `sync: true` are independent. A model can have field
filtering for online use without being sync-enabled, or be sync-enabled with
no field allowlist (every field flows through).

### 3. Per-request `SyncPolicy`

A single policy callback evaluated for every pull/push/watch op. Returns
`allow`, an optional `filter` (per-user scoping on pull/watch), and an
optional `transform` (server-owned invariants on push).

```ts
// mogobase/syncPolicy.ts
import type { SyncPolicy } from "mogobase/server"
import { getSession } from "./auth"

export const syncPolicy: SyncPolicy = async ({ op, model, headers }) => {
  const session = await getSession({ headers })
  if (!session) return { allow: false }
  const userId = session.user.id

  if (model === "posts" || model === "categories") {
    return {
      allow: true,
      filter: { userId },
      transform: (doc, existing) => {
        if (existing && existing.userId !== userId) {
          throw new Error("Forbidden: cross-tenant write")
        }
        return { ...doc, userId }
      },
    }
  }

  return { allow: false }
}
```

Wire the same policy into both transports:

```ts
// server.ts (custom Next.js server)
import { attachMogobaseWebSocket } from "mogobase/server"
import { syncPolicy } from "./mogobase/syncPolicy"

attachMogobaseWebSocket(server, "/ws", { syncPolicy })
```

```ts
// app/api/sync/route.ts (HTTP fallback — `mogobase install` writes a template
// you fill in; replace its inline policy with your shared one)
import { syncPolicy } from "../../../../mogobase/syncPolicy"
```

Decision contract:

```ts
type SyncPolicyContext = {
  op: "pull" | "push" | "watch"
  model: string
  headers: HeaderView  // one shape from every door (headerView): a Fetch Headers copy, plus plain lowercase keys
}

type SyncPolicyDecision = {
  allow: boolean
  filter?: Record<string, any>
  transform?: (doc: any, existing: any | null) => any | Promise<any>
}
```

`headers` is the same object whichever transport the call came by — attachWs, the legacy `ws.ts`, `hono.ts`'s `/api/sync`, or the Next.js sync route template (which asks it through `evaluateSyncPolicy`, exported from `mogobase/server/sync` with `headerView`): read it as `headers["authorization"]` or `headers.get("authorization")`. It is a real `Headers` (a copy), so a library that wants one — an `instanceof Headers` check, `new Request(url, { headers })` — takes it as it is. An app route copied before 4.0.0 calls the policy itself with `request.headers` — replace `syncPolicy({ op, model, headers: request.headers })` with `evaluateSyncPolicy(syncPolicy, op, model, request.headers)` to give it the same shape, and a throwing policy the same logged 403.

Behavior:

- `allow: false` → WS subscribe drops that model from the spec list; pull/push
  return `Forbidden`. The HTTP route returns 403.
- `filter` — merged into the pull query as a server-side WHERE (combines with
  the `updatedAt > checkpoint` filter via `$and`), and translated to a change-
  stream `$match` pipeline (`{userId: x}` → `[{$match: {"fullDocument.userId": x}}]`)
  so MongoDB only notifies for docs in scope. Don't emulate filtering in the
  transform — it must run in the database.
- `transform(doc, existing)` runs once per pushed row. Throw to reject — the
  row is treated as a conflict and the existing server doc is returned to the
  client unchanged. Return value (or `next` if you return `undefined`) becomes
  the persisted shape after a defensive re-strip against `clientFields`.
- Policy throws are caught and treated as `{allow: false}` — fail-closed.

### 4. Server-owned timestamps

Regardless of what the client sends, every write to MongoDB gets:

```
updatedAt:  Date.now()
createdAt:  existing.createdAt ?? Date.now()
deletedAt:  isTombstone ? (existing.deletedAt ?? Date.now()) : null
```

The client's `updatedAt` is still used for conflict detection (last-writer-
wins ordering), but storage is always authoritative. A client lying about
timestamps to win a conflict can still lose subsequent writes.

### 5. Push batch cap

`pushChanges` rejects batches larger than 500 rows with
`Push batch exceeds 500 rows`. The whole batch is rejected (not silently
truncated) so the client knows to reduce its push size.

### 6. Soft-delete invariant

Sync requires soft-deletes (the auto-stamp wrapper rewrites `deleteOne` →
`$set: {deletedAt, updatedAt}`). MongoDB delete events don't carry
`fullDocument`, so a `{$match: {"fullDocument.userId": x}}` pipeline drops
hard-delete events — clients miss tombstones and the doc lives forever in
their local store. If you bypass the wrapper for a hard delete on a synced
model, sync correctness breaks for clients with policy filters.

### Shared change streams

`streamChanges` and the WebSocket sync-subscribe path both go through a
`streamHub` (`src/server/streamHub.ts`). One MongoDB change stream is opened
per active (database, model) — sync always watches the default database —
regardless of how many clients are subscribed; the policy `filter` returned by
`syncPolicy({op:"watch",...})` is evaluated in JS via `runtime/filterMatcher`
to decide which clients receive each event. This bounds MongoDB cursor count
by *number of synced models*, not number of connected users — **except** for a
policy filter the JS matcher cannot evaluate (`$elemMatch`, `$expr`, …): that
model's stream is opened per subscribed client, each holding a pooled
connection (logged once, naming the operator). Keep watch filters to the
supported operators, and size `maxPoolSize` as the scaling guide describes.

Only models declared `sync: true` stream — a `sync-subscribe` naming any other
model (or a time-series one) is refused, like pull and push. The exported
`streamChanges(specs, onEvent)` follows the same rule: for a model not declared
`sync: true` it logs `Model "X" is not configured for sync` and streams nothing.
Code that used it as a general change notifier on other collections should use
`collection.watch()` (or declare the model `sync: true`, with a policy).

## Wire protocol

All sync traffic is multiplexed onto the same `/ws` socket the existing
mogobase setup uses. Message types:

```ts
{ type: "sync-subscribe", models: string[] }                          // C→S
{ type: "sync-stream",    model: string }                             // S→C, fires on any change in scope
{ type: "sync-pull",      model, checkpoint, batchSize }              // C→S
{ type: "SyncPullResult", model, documents: SyncDoc[], checkpoint }   // S→C
{ type: "sync-push",      model, rows: { assumedMasterState, newDocumentState }[] }  // C→S
{ type: "SyncPushResult", model, conflicts: SyncDoc[] }               // S→C
```

A pull answers the rows changed after `checkpoint` (a numeric `updatedAt`), oldest first, at most `batchSize` (capped at 1000) — except that a batch never ends inside a group of rows sharing one `updatedAt`: the rest of that group comes in the same answer, past `batchSize`. A soft `deleteMany` stamps every row it deletes with one `updatedAt`, and a batch cut inside the group lost the rest of it for good (the next pull asks for rows after the checkpoint). A client keeps pulling while an answer is full (`documents.length >= batchSize`); one that stops at exactly `batchSize` must use `>=`. So a soft `deleteMany` of 100 000 rows is one pull answer of 100 000 tombstones for every client — and a client that pulls while such a write is still being applied (one `updateMany` of many rows takes seconds) gets the rows written so far, a checkpoint at their stamp, and never the rest (main behaves the same; holding checkpoints back a few seconds would close it, at a cost to every pull — not in 4.0.0). Delete very large sets in chunks of a few thousand rows (by `_id` range), each chunk a separate `deleteMany`: each write is then short, and each pull answer small.

Rows whose `updatedAt` is a Date (an import's, or a caller's `new Date()`), and rows with no `updatedAt` but a numeric `createdAt` (written before sync), are pulled in order with the rest. Rows a pull cannot page — a string `updatedAt`, a `createdAt` that is not a number with no `updatedAt`, or no timestamp at all — come only in a client's first pull, ahead of the rest and at most one batch of them: the server warns once per model (`<model> has rows sync cannot page`). Stamp them before enabling sync, with the time of the fix — stamped with their own old date, a client whose checkpoint is already past it would never pull them — in chunks, so no pull answer carries them all (MongoDB 4.2+):

```js
let ids
do {
  ids = db.todos.find({ updatedAt: { $not: { $type: "number" } } }, { _id: 1 }).limit(1000).toArray().map((d) => d._id)
  db.todos.updateMany({ _id: { $in: ids } }, [{ $set: { updatedAt: { $toLong: "$$NOW" } } }])
} while (ids.length)
```

`SyncDoc` adds three sync-specific fields on top of your record:

```ts
{
  _id:        string                   // server normalizes ObjectId.toString()
  updatedAt:  number                   // ms; server-owned
  deletedAt:  number | null
  _deleted:   boolean                  // !!deletedAt
  // ...your clientFields
}
```

An HTTP fallback is also available at `POST /api/sync?action=pull|push` —
shipped by `mogobase install` into your Next.js app — for environments where
WebSockets are blocked. Wire the same `syncPolicy` into the HTTP route as
into `attachMogobaseWebSocket` so both transports enforce the same rules.

## Auto-stamping

Sync correctness rests on `updatedAt`. Mogobase stamps it transparently:

- **Server**: `_runMutation` wraps the `db.model(name)` collection in a Proxy.
  - `insertOne` / `insertMany` inject `createdAt`, `updatedAt`, default
    `deletedAt: null`.
  - `updateOne` / `updateMany` inject `updatedAt` into the update.
  - **`deleteOne` / `deleteMany` are rewritten to soft-delete** (`$set` of
    `deletedAt` + `updatedAt`). Handlers needing a real hard delete must
    bypass the wrapper and call `db.collection.deleteOne()` directly via
    the underlying MongoDB client. **Don't do this on a sync-enabled model
    if any client uses a policy filter** — see "Soft-delete invariant" above.
  - When the model has `dbValidation: true` (see models guide), the same
    wrapper validates each write against the zod schema after stamping. Note
    that **sync push (`pushChanges`) writes to the raw collection, not
    through this wrapper**, so `dbValidation` does **not** gate
    sync-pushed rows — the policy `transform` callback is what guards
    sync-push payload shape.
- **Sync push**: server timestamps override client values. The client's
  `updatedAt` is consulted for conflict detection only.
- **Client (RxDB and Watermelon adapters)**: same pattern. Writes go through
  the same wrappers so an offline write replays through the sync engine with
  the correct `updatedAt`.
- **Indexes**: `defineModel` always creates indexes on `updatedAt`,
  `deletedAt`, `createdAt` (server) and on `updatedAt`/`deletedAt` (RxDB).
  MongoDB no-ops on duplicate index creates.

## Conflict resolution

Default: server wins. The push handler compares the assumed-master
`updatedAt` against the server's actual `updatedAt`. If the server is ahead,
the server's row is returned in the `conflicts` array and the client merges
it into its local store on the next pull.

A policy `transform` that throws also produces a conflict — the existing
server row is returned, and the client's tampered write is rejected without
modifying storage.

To customize on the client:

```ts
const syncOptions = {
  conflictResolver: (model, local, remote) => {
    // Return the doc you want to keep. Default is `remote`.
    return remote
  },
}
```

## Status & lifecycle

`SyncHandle` returned by the engines exposes:

```ts
type SyncHandle = {
  status: "idle" | "pulling" | "pushing" | "live" | "error"
  cancel: () => Promise<void>
  onStatusChange: (cb) => () => void
}
```

The provider stores the handle in a ref and cancels it on unmount or when
`online`/`sync`/`clientDB` props change.

WS reconnection: each engine has a 3s reconnect loop; on reconnect a
`sync-subscribe` is re-sent and a fresh resync is triggered.

## Stability

`syncOptions` is in the provider's effect dep array. An inline `{}` literal
will tear down + restart sync every render. **Always memoize:**

```tsx
const syncOptions = useMemo(() => ({ batchSize: 500 }), [])
```

…or define at module scope.

## Pagination in sync handlers

Sync-mode handlers run on both server (real Mongo) and client (RxDB / WatermelonDB adapter). Server-side pagination via `mongo-cursor-pagination` doesn't run in the browser — it depends on Node-only Mongo internals. `mogobase/runtime` ships two helpers for this case:

- `isServer()` — `typeof window === "undefined"` runtime check.
- `MongoPaging` — browser-safe polyfill of `mongo-cursor-pagination`'s `MongoPaging.find(col, params)`. Same return shape; cursor tokens are `base64url(JSON.stringify(value))`. Works against any `find(filter).toArray()`-shaped collection.

Pattern:

```ts
import {
  query, v, PaginationQueryArgs,
  isServer, MongoPaging as MongoPagingPolyfill,
} from "mogobase/runtime"
import MongoPaging from "mongo-cursor-pagination"

const Pager = isServer() ? (MongoPaging as any) : MongoPagingPolyfill
```

See `mogobase://guide/handlers` ("Isomorphic handlers") for the full example.

## Edge cases

- **`_id` must be string**: client UUIDs are produced via `crypto.randomUUID()`.
  Existing collections with `ObjectId` `_id`s are incompatible.
- **`updatedAt` retrofit**: pre-existing docs without `updatedAt` are treated
  as `epoch` so they're picked up on first pull.
- **Soft-delete propagation**: `pullChanges` does NOT filter `deletedAt: null`
  — tombstones must travel. Client queries that filter via
  `buildMongoFilters` continue to filter out deleted rows on read.
- **Hard delete on a synced model with a policy filter** breaks tombstone
  propagation (Mongo delete events don't carry `fullDocument`). Either accept
  soft-delete or remove `sync: true` for that model.
- **WatermelonDB cross-tab + sync**: `synchronize()` writes through Watermelon's
  internal `_applyChanges` path, bypassing `WatermelonMongoAdapter`'s
  `BroadcastChannel`. So sync-applied writes don't broadcast to peer tabs.
  Each tab pulls independently. This is correct behavior — peers stay
  consistent through the server.
- **WatermelonDB initial sync**: `synchronize()` does a full pull per cycle.
  For >10K records per model the first sync may be slow. RxDB does not have
  this limitation.
