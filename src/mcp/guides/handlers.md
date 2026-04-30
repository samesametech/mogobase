# Handlers: query, mutation, internalQuery, internalMutation

Mogobase handlers live in `./mogobase/*.ts`. Each file runs at module scope — calling `query()` or `mutation()` registers the handler on the global singleton.

## Golden rule: import from `mogobase/runtime`

```ts
import { query, mutation, internalQuery, internalMutation, v, defineModel } from "mogobase/runtime"
```

NEVER import from `mogobase/server` in handler files. The `runtime` barrel is isomorphic (works in browser for offline replay) and excludes Node-only modules. `mogobase/server` brings in `mongodb`, `ws`, and `hono` which will break the browser bundle.

## Args validation

`args` is a **zod v4** schema (re-exported as `v`). Args are validated via `safeParseAsync` before the handler runs. Throw-on-first-error — the first `.issues[0].message` is returned to the caller.

```ts
import { query, v } from "mogobase/runtime"

query("getUser", {
  args: v.object({ id: v.string() }),
  handler: async ({ id }, { db }) => {
    return db.model("users").findOne({ _id: id })
  },
})
```

For queries with no args: `args: v.object({})`.

## Handler context (`ctx`)

The second parameter of every handler is `ctx` with these fields:

| Field | Available in | Purpose |
|---|---|---|
| `db` | queries + mutations | The `MogobaseDB` (online) or `MogobaseClientDB` (offline) singleton. Use `db.model(name)` to get a collection-shaped adapter. |
| `runQuery(name, args)` | queries + mutations | Call another query handler. Internal names must be prefixed: `runQuery("internal.foo", args)`. |
| `runMutation(name, args)` | queries + mutations | Call another mutation handler. |
| `headers` | queries + mutations | Incoming request headers (from the HTTP POST or the WebSocket upgrade). Use for auth. |
| `watch(modelName, filterOrPipeline?, options?)` | **queries only** | Opt into live-query semantics. When called, the server keeps a MongoDB change stream open and pushes updates on the open WebSocket to this query subscription. Both `useQuery` and `usePaginatedQuery` trigger a fresh handler run on every passing change-stream event — `usePaginatedQuery` re-runs the handler with the loaded window as the `limit` and pushes a new `PaginatedQueryResult`. |

### `ctx.watch` second arg: aggregation pipeline

The second arg is the same shape you'd pass to `collection.watch(pipeline)` — an aggregation pipeline operating on the change event document. Paths use the native change-stream layout (`fullDocument.<field>`, `operationType`, `documentKey._id`, …):

```ts
ctx.watch("itemMembers", {
  $match: {
    $or: [
      { "fullDocument.documentId": args.id },
      { "operationType": "delete" },
    ],
  },
})
```

Accepted shapes:

- **Single `$match` stage object** (above) — fast path. The filter is evaluated in JS by the shared streamHub, so all sockets watching the same model share one MongoDB change stream.
- **Array of stages** — full aggregation pipeline. If every stage is `$match`, still on the streamHub fast path (stages are AND'd). Any non-`$match` stage (e.g., `$project`, `$addFields`) falls back to a per-socket `collection.watch(pipeline)`.
- **Bare doc filter** (e.g., `{ userId: "x" }`) — backward-compat shorthand. Auto-translated to `{ $or: [{ "fullDocument.userId": "x" }, { "operationType": "delete" }] }` so deletes still notify the subscriber even though delete events carry no `fullDocument`.
- **Omitted** — unfiltered watch. The handler re-runs on every change to the collection.

Unsupported filter operators (`$expr`, `$where`, `$elemMatch`, `$text`) throw at subscribe time. Reach for the multi-stage pipeline form when you need them — that path runs your pipeline through MongoDB itself instead of the JS matcher.

### `ctx.watch` options

The third arg is forwarded to `collection.watch(pipeline, options)` as `ChangeStreamOptions` (e.g., `startAfter`, `resumeAfter`). Pagination options like `paginatedField` / `sortAscending` are **not** needed on `ctx.watch` anymore — they only live in `args.paginationOpts`.

The server sets `fullDocument: "updateLookup"` automatically (and for `useQuery` also `fullDocumentBeforeChange: "whenAvailable"`), so those keys never need to be passed explicitly. The paginated path omits `fullDocumentBeforeChange` because change events are only used to trigger a refetch — the changed document itself isn't read.

## Queries

Queries are idempotent read handlers. In a WebSocket-subscribed query, call `ctx.watch("modelName")` once at the top to enable live updates.

```ts
import { query, v } from "mogobase/runtime"

query("listTodos", {
  args: v.object({ done: v.boolean().optional() }),
  handler: async ({ done }, { db, watch }) => {
    watch("todos")
    const filter = done === undefined ? {} : { done }
    return db.model("todos").find(filter).sort({ createdAt: -1 }).toArray()
  },
})
```

## Mutations

Mutations are writes. No `watch`. Return whatever you want — the value is sent back to the caller.

```ts
import { mutation, v } from "mogobase/runtime"

mutation("updateTodo", {
  args: v.object({ id: v.string(), done: v.boolean() }),
  handler: async ({ id, done }, { db }) => {
    await db.model("todos").updateOne({ _id: id }, { $set: { done, updatedAt: Date.now() } })
    return true
  },
})
```

## internalQuery / internalMutation

Same signature as `query` / `mutation` but NOT exposed to clients. Only callable from other handlers via `ctx.runQuery("internal.xxx", args)` / `ctx.runMutation("internal.xxx", args)`. The name is automatically prefixed with `internal.` when stored.

```ts
import { internalMutation, mutation, v } from "mogobase/runtime"

internalMutation("_stampAudit", {
  args: v.object({ userId: v.string(), action: v.string() }),
  handler: async ({ userId, action }, { db }) => {
    await db.model("audit").insertOne({ userId, action, at: Date.now() })
  },
})

mutation("publishPost", {
  args: v.object({ id: v.string() }),
  handler: async ({ id }, { db, runMutation, headers }) => {
    await db.model("posts").updateOne({ _id: id }, { $set: { published: true } })
    const userId = headers?.["x-user-id"]
    if (userId) await runMutation("internal._stampAudit", { userId, action: "publishPost" })
    return true
  },
})
```

## Paginated queries

Use the exported `PaginationQueryArgs` helper for cursor-based args — pairs with `usePaginatedQuery` on the client. The return shape must match `{ results, hasNext, hasPrevious, next, previous }` (the contract of `mongo-cursor-pagination`).

### Online-only handlers

If the handler is only ever exercised on the server (pure `online={true}` apps), import `mongo-cursor-pagination` directly:

```ts
import { query, v, PaginationQueryArgs } from "mogobase/runtime"
import MongoPaging from "mongo-cursor-pagination"

query("listPosts", {
  args: PaginationQueryArgs.extend({ authorId: v.string().optional() }),
  handler: async (args, { db, watch }) => {
    const filter: any = {}
    if (args.authorId) filter.authorId = args.authorId

    // Trigger a refetch whenever any post changes. The server will re-run this
    // handler with paginationOpts.limit set to however many rows the client has
    // loaded (initial pageSize + any loadNext or loadPrevious calls).
    watch("posts")

    return await MongoPaging.find(db.model("posts").collection, {
      query: filter,
      paginatedField: "_id",
      ...args.paginationOpts,
    })
  },
})
```

### Isomorphic handlers (sync / offline mode)

Handlers that run on both server (real Mongo) and client (RxDB / WatermelonDB adapter) — i.e. anything in offline mode or `online={true} sync={true}` mode — can't use `mongo-cursor-pagination` directly: the package depends on Node-only Mongo internals and BSON. Mogobase ships a browser-safe polyfill of `MongoPaging.find` from `mogobase/runtime`. Dispatch on `isServer()`:

```ts
import {
  query, v, PaginationQueryArgs,
  isServer, MongoPaging as MongoPagingPolyfill,
} from "mogobase/runtime"
import MongoPaging from "mongo-cursor-pagination"

const Pager: { find: (col: any, params: any) => Promise<any> } =
  isServer() ? (MongoPaging as any) : MongoPagingPolyfill

query("listPosts", {
  args: v.object({ filter: v.any(), paginationOpts: PaginationQueryArgs }),
  handler: async ({ filter, paginationOpts }, { db, watch }) => {
    watch("posts")
    return Pager.find(db.model("posts"), {
      query: { ...filter, deletedAt: null },
      paginatedField: "_id",
      ...paginationOpts,
    })
  },
})
```

Behavior of the polyfill:

- Operates on any `find(filter).toArray()`-shaped collection — both `RxMongoAdapter` and `WatermelonMongoAdapter` qualify.
- Returns the same `{ results, previous, next, hasPrevious, hasNext }` shape as upstream.
- Cursor tokens are `base64url(JSON.stringify(value))`. Tokens issued by the server (BSON-encoded EJSON) and the polyfill (plain JSON) are **not interchangeable** within a single paginated query — but each side stays consistent within its own page sequence, which is what the hook needs.
- Pulls the full matched set into memory then sorts/filters/slices in JS. Adequate for the per-user datasets typical in offline / sync flows; do not use the polyfill on the server against million-row collections.

The handler hardcodes `paginatedField: "_id"` — that is the source of truth for the sort field. `PaginationQueryArgs` exposes an optional `paginatedField` in the schema and `usePaginatedQuery` accepts one as a hook option, but both are ignored unless the handler explicitly reads `args.paginationOpts.paginatedField` and forwards it. Pick one field per handler and stick with it.

If the handler enriches rows from other collections (e.g., `post.category`), call `ctx.watch("categories")` too — every watched collection triggers a full refetch on change, so category-name edits propagate into the rendered posts.

## Filtering server-only fields out of return values

When a model has `clientFields` set on `defineModel`, online handlers should
strip server-only fields before returning. The runtime ships
`filterClientFields(model, input)` for this:

```ts
import { query, v, filterClientFields } from "mogobase/runtime"
import { Id } from "mogobase/db"

query("posts.get", {
  args: v.object({ id: v.string() }),
  handler: async ({ id }, { db, watch }) => {
    watch("posts")
    const doc = await db.model("posts").findOne({ _id: new Id(id) })
    if (!doc) return null
    return filterClientFields("posts", doc)
  },
})
```

Behavior:

- Looks up the model's `clientFields` allowlist; projects each doc to
  `clientFields ∪ engine fields` (`_id`, `createdAt`, `updatedAt`,
  `deletedAt`).
- If the model has no `clientFields` configured, returns `input` unchanged.
- Handles three input shapes:
  - single document → projected document
  - array of documents → array of projected documents
  - paginated result `{ results: [...], hasNext, ... }` → same shape with
    `results` projected, other fields preserved.

The same allowlist also enforces the sync engine's pull projection and push
strip. Setting `clientFields` once on `defineModel` covers both transports.

For enrichment fields (e.g. `post.category` joined from another collection),
project the base doc first, then attach the enrichment:

```ts
const projected: any = filterClientFields("posts", doc)
if (doc.categoryId) projected.category = await categoryByIdLoader.load(doc.categoryId)
return projected
```

## Naming conventions

- Query names are verbs or noun+verbs: `listTodos`, `getUser`, `searchPosts`.
- Mutation names are verbs: `createTodo`, `updateTodo`, `deleteTodo`.
- Internal names start with `internal` (then any suffix you want). Example: `internalCleanupExpiredSessions`.

## Don't do this

- Don't define handlers outside `./mogobase/*.ts` — the custom `server.ts` only imports that folder.
- Don't duplicate handler names — registration throws `Handler ${name} already exists`.
- Don't perform heavy work at module scope — keep module-level code to `defineModel()` + `query()` / `mutation()` registrations.
- Don't rely on module-level closures for request-scoped state — handlers may run concurrently.
