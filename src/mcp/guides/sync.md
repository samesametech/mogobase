# Sync Mode (Local-First)

Mogobase has three runtime modes:

| Provider props                                   | Reads / writes go through       | Server contact                |
| ------------------------------------------------ | ------------------------------- | ----------------------------- |
| `online={true}`                                  | WebSocket / `/api/handlers`     | every read & write            |
| `online={false}` + `clientDB`                    | clientDB (RxDB or Watermelon)   | none                          |
| `online={true}` + `sync={true}` + `clientDB`     | clientDB                        | continuous background sync    |

This guide covers the third mode.

## Enabling sync

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

## Wire protocol

All sync traffic is multiplexed onto the same `/ws` socket the existing
mogobase setup uses. New message types:

```ts
{ type: "sync-subscribe", models: string[] }                          // C→S
{ type: "sync-stream",    model: string }                             // S→C, fires on any change
{ type: "sync-pull",      model, checkpoint, batchSize }              // C→S
{ type: "SyncPullResult", model, documents: SyncDoc[], checkpoint }   // S→C
{ type: "sync-push",      model, rows: { assumedMasterState, newDocumentState }[] }  // C→S
{ type: "SyncPushResult", model, conflicts: SyncDoc[] }               // S→C
```

`SyncDoc` adds three sync-specific fields on top of your record:

```ts
{
  _id:        string                   // server normalizes ObjectId.toString()
  updatedAt:  string                   // ISO; auto-stamped
  deletedAt:  string | null
  _deleted:   boolean                  // !!deletedAt
  // ...your fields
}
```

An HTTP fallback is also available at `POST /api/sync?action=pull|push` —
shipped by `mogobase install` into your Next.js app — for environments where
WebSockets are blocked.

## Auto-stamping

Sync correctness rests on `updatedAt`. Mogobase stamps it transparently:

- **Server**: `_runMutation` wraps the `db.model(name)` collection in a Proxy.
  - `insertOne` / `insertMany` inject `createdAt`, `updatedAt`, default
    `deletedAt: null`.
  - `updateOne` / `updateMany` inject `updatedAt` into the update.
  - **`deleteOne` / `deleteMany` are rewritten to soft-delete** (`$set` of
    `deletedAt` + `updatedAt`). Handlers needing a real hard delete must
    bypass the wrapper and call `db.collection.deleteOne()` directly via
    the underlying MongoDB client.
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

To customize:

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
- **WatermelonDB cross-tab + sync**: `synchronize()` writes through Watermelon's
  internal `_applyChanges` path, bypassing `WatermelonMongoAdapter`'s
  `BroadcastChannel`. So sync-applied writes don't broadcast to peer tabs.
  Each tab pulls independently. This is correct behavior — peers stay
  consistent through the server.
- **WatermelonDB initial sync**: `synchronize()` does a full pull per cycle.
  For >10K records per model the first sync may be slow. RxDB does not have
  this limitation.
