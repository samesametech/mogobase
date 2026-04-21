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

### `ctx.watch` second arg: filter vs pipeline

- **Array** → interpreted as an aggregation pipeline passed through to `collection.watch(pipeline)`. Use this when you need server-side pre-filtering of the change stream (e.g., only events for docs whose `_id` matches). Both `useQuery` and `usePaginatedQuery` trigger a fresh handler run on every passing event.
- **Plain object** → ignored. Legacy from the window-scoped paginated path; kept in the signature so existing handlers still compile. Use a pipeline instead when you need server-side filtering.
- **Omitted** → unfiltered watch. The handler re-runs on every change to the collection.

### `ctx.watch` options

The third arg is forwarded to `collection.watch(pipeline, options)` as `ChangeStreamOptions` (e.g., `startAfter`, `resumeAfter`). The server always sets `fullDocument: "updateLookup"` for `useQuery`; paginated handlers don't need the full document on change events (they just re-run the handler), so pagination options like `paginatedField` / `sortAscending` are **not** needed on `ctx.watch` anymore — they only live in `args.paginationOpts`.

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
    // loaded (initial pageSize + any loadNext calls).
    watch("posts")

    return await MongoPaging.find(db.model("posts").collection, {
      query: filter,
      paginatedField: "_id",
      limit: args.paginationOpts.limit,
      sortAscending: args.paginationOpts.sortAscending,
      next: args.paginationOpts.next,
      previous: args.paginationOpts.previous,
    })
  },
})
```

If the handler enriches rows from other collections (e.g., `post.category`), call `ctx.watch("categories")` too — every watched collection triggers a full refetch on change, so category-name edits propagate into the rendered posts.

## Naming conventions

- Query names are verbs or noun+verbs: `listTodos`, `getUser`, `searchPosts`.
- Mutation names are verbs: `createTodo`, `updateTodo`, `deleteTodo`.
- Internal names start with `internal` (then any suffix you want). Example: `internalCleanupExpiredSessions`.

## Don't do this

- Don't define handlers outside `./mogobase/*.ts` — the custom `server.ts` only imports that folder.
- Don't duplicate handler names — registration throws `Handler ${name} already exists`.
- Don't perform heavy work at module scope — keep module-level code to `defineModel()` + `query()` / `mutation()` registrations.
- Don't rely on module-level closures for request-scoped state — handlers may run concurrently.
