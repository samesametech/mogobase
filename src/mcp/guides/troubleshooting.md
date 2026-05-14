# Troubleshooting

## `useMogobase()` throws "MogobaseContext not found"

The hook is being called outside a `<MogobaseProvider>`. Wrap your app (typically via `app/providers.tsx`) and mount that client component inside `app/layout.tsx`. The provider file must have `"use client"` at the top.

## WebSocket not connecting / live queries don't update

Root causes, in order of likelihood:

1. **Running `next dev` instead of `tsx server.ts`.** The default Next.js dev server doesn't attach the mogobase WebSocket. Update `package.json` scripts:
   ```json
   { "dev": "tsx server.ts", "start": "NODE_ENV=production tsx server.ts" }
   ```
2. **Cross-origin frontend.** The hook connects to `window.location.origin`. If Next.js runs on one port and mogobase on another, set `NEXT_PUBLIC_MOGOBASE_URL=https://…` and `MOGOBASE_URL=https://…`.
3. **Handler file didn't load.** If `./mogobase/foo.ts` isn't imported by the custom `server.ts`, registration never happens. Confirm the file is present and the boot log shows `[mogobase] loaded ./mogobase/foo.ts`.
4. **Missing `watch()` call in the query handler.** Live updates require the handler to call `ctx.watch("modelName")`. Without it, the query returns once and doesn't refresh.

## "Query X not found" from the WebSocket

The handler didn't register. Check:

- The file is at `./mogobase/*.ts` (not nested — the loader only scans the top level).
- The file imports from `mogobase/runtime` (not some other path).
- `query("name", …)` is called at module scope (not inside a function).
- No typo mismatch between the registered name and the one passed to `useQuery("name")`.

## "Handler X already exists"

Double registration. Two handlers with the same name in two files (or the same file imported twice from different paths). Check for duplicate `./mogobase/*.ts` entries.

## `ctx.db is required` error

The server ran the handler without passing `db`. This usually means a custom caller (direct `runQuery`/`runMutation` from app code) didn't pass a ctx. Let the WebSocket + route handler supply ctx — don't call `runQuery` directly from app code.

## Offline mode: handler runs but data is empty

Common causes:

1. **`defineModel` wasn't called for the collection.** Offline adapters need the model registered. Add `defineModel("todos")` to the handler file.
2. **Handler imports something Node-only.** If a handler file transitively imports `mongodb`, `ws`, or `fs`, the browser bundle breaks. Use `mogobase/runtime`, never `mogobase/server`.
3. **WatermelonDB: model registered after DB access.** Register all models at module scope in `./mogobase/*.ts` — don't lazy-add after the first hook runs. See `offline-backends`.

## `MONGO_URI` connection refused

The MongoDB instance isn't reachable. Check:

- Local: `brew services list` shows MongoDB running.
- Docker: `docker ps` shows the mongo container; the port mapping matches `MONGO_URI`.
- Atlas: the connection string is correct and the current IP is whitelisted.

Defaults are `mongodb://localhost:27017` and `MONGO_DB=mogobase`.

## `tsx server.ts` fails to find modules

The custom server is meant to be run at the project root via `tsx`. If you moved `server.ts`, adjust imports accordingly. Re-run `npx mogobase install` to restore the template.

## Build error: `Cannot find module 'rxdb'` or `'@nozbe/watermelondb'`

Both backends are **optional peer dependencies** in mogobase 2.6+. The consumer's bundler only walks into the backend code if the consumer's source `import`s it. Causes:

1. **You imported the backend without installing it.** If your app has `import RxClientDB from "mogobase/client-db"`, install `rxdb`. If it has `import WatermelonClientDB from "mogobase/client-db/watermelon"`, install `@nozbe/watermelondb`.
2. **You don't actually need offline mode but left a stale import in place.** Remove the `import` and the `clientDB={…}` prop. Online-only apps need neither package.

## `<MogobaseProvider online={false}>` throws "requires a `clientDB` prop"

Offline mode requires you to pass the backend singleton:

```tsx
import RxClientDB from "mogobase/client-db"
<MogobaseProvider online={false} clientDB={RxClientDB} handlers={() => import("@/mogobase")}>
```

If you don't need offline at all, set `online={true}` (and skip `clientDB` + `handlers`).

## Migrating from `offlineAdapter` (mogobase ≤ 2.5)

The `offlineAdapter="rxdb" | "watermelon"` prop was removed in 2.6. Replace it with `clientDB` and an explicit import:

```diff
- import MogobaseProvider from "mogobase/provider"
+ import MogobaseProvider from "mogobase/provider"
+ import RxClientDB from "mogobase/client-db"

  <MogobaseProvider
    online={online}
-   offlineAdapter="rxdb"
+   clientDB={RxClientDB}
    handlers={() => import("@/mogobase")}
  >
```

For watermelon, swap to `import WatermelonClientDB from "mogobase/client-db/watermelon"`. Online-only apps drop the `clientDB` line entirely and uninstall `rxdb` / `@nozbe/watermelondb` if present.

## Paginated query: doc changes aren't pushed

`usePaginatedQuery` refetches the full loaded window whenever any `ctx.watch(modelName)`-registered collection emits a change-stream event. If live updates aren't arriving:

1. Confirm the handler calls `ctx.watch("<collection>")` for every collection whose data influences the query output. Enriched queries (e.g., posts with a joined `category`) need `ctx.watch("posts")` **and** `ctx.watch("categories")`.
2. Confirm your Mongo deployment supports change streams (replica set or sharded cluster — standalone `mongod` does not emit events).
3. Check the browser network tab: you should see a single WebSocket connection and a `PaginatedQueryResult` frame after every upstream mutation.

## Paginated query: custom `paginatedField` not sorting

The server no longer tracks per-window boundaries — the handler's own `MongoPaging.find` call controls sort order. If a different `paginatedField` isn't being honored, confirm the handler passes it to `MongoPaging.find` and that the client hook's `paginationData.paginatedField` matches. The `paginatedField` option on `ctx.watch` is no longer consumed; it's safe to remove.

## Offline: tab B doesn't see writes from tab A

Both tabs must be using the same `dbName` on the `MogobaseProvider`. If different names are in play, the BroadcastChannel topic (`mogobase-watermelon-<dbName>` or the RxDB equivalent) is different and messages aren't shared. Also confirm you're not in a context where `BroadcastChannel` is unavailable (older browsers, some WebView embeddings).

## Sync: `Model "X" is not configured for sync`

The model must opt into sync explicitly (default-deny):

```ts
defineModel("posts", schema, { sync: true })
```

Common cause: the server's auto-loader only loads `./mogobase/*.ts`. If
sync-mode handlers live in a separate folder (e.g. `./mogobase-sync/*.ts`)
they only register on the client, so the server never sees `sync: true`.
Either move the `defineModel` call into a file under `./mogobase/`, or have
the custom `server.ts` load both folders. The `mogobase install` template
loads only `./mogobase/`; extend the loader if you split the folders.

## Sync: client gets 403 / `Forbidden` on every pull or push

The `SyncPolicy` denied the request. Default-deny means a missing or
mis-wired policy returns `Forbidden` for everything. Check:

1. The policy is wired into both transports — `attachMogobaseWebSocket(server, "/ws", { syncPolicy })` in `server.ts` AND the same policy imported in `app/api/sync/route.ts`.
2. The policy returns `{allow: true}` for the model in question. Default behavior for unknown models should be `{allow: false}` — make sure the model name matches exactly.
3. The session lookup inside the policy is finding the user. Better-auth and similar libraries accept either a Node `IncomingMessage` headers object or a WHATWG `Headers` instance, but only when called with the right signature; an undefined/empty session means `{allow: false}`.
4. Policy throws are logged as `[mogobase/sync] policy threw …` and converted to `{allow: false}`.

## Sync: client sees other users' data

`filter` is the per-user scoping mechanism — without it, sync is allowed
but unscoped, and every authenticated user sees every doc.

```ts
return { allow: true, filter: { userId: session.user.id }, transform: ... }
```

Don't try to filter inside `transform` — it only runs on push, not pull.
The `filter` is merged into the pull query (`$and` with the `updatedAt >
checkpoint` filter) and translated to a change-stream `$match` pipeline so
MongoDB only notifies for in-scope docs.

## Sync: cross-tenant write succeeds when it should fail

Either the `transform` is missing, or it returns the doc unchanged for a
foreign-tenant write. The expected pattern:

```ts
transform: (doc, existing) => {
  if (existing && existing.userId !== userId) {
    throw new Error("Forbidden")  // becomes a conflict, server doc preserved
  }
  return { ...doc, userId }       // force the field even on create
}
```

Throwing inside `transform` is the kill switch — the row is treated as a
conflict, the server's existing version is returned, and storage is not
touched.

## Mutation throws `[mogobase] Validation failed for <model>.<op>`

The model has `dbValidation: true` and the payload didn't match the zod
schema. The error message lists each failing path:

```
[mogobase] Validation failed for posts.insertOne: title: Invalid input: expected string, received number; userId: Invalid input: expected string, received undefined
```

Common causes:

1. **Args schema is looser than the model schema.** `query/mutation` `args`
   declared `description: v.string().optional()`, the model schema declared
   `description: v.string()`. The handler builds the doc from args and
   inserts it without `description` — model schema rejects it. Fix: tighten
   the args schema, default the field in the handler, or relax the model
   schema.
2. **Internal `insertOne` from a different shape.** A handler does
   `db.model("posts").insertOne({...args, computedField: 42})` but the
   model schema doesn't list `computedField` and uses strict mode. Fix:
   add the field to the schema, or remove `dbValidation: true` if you
   want the schema to stay informational.
3. **Update touches a field with the wrong type.** `$set: { qty: "5" }`
   where the schema says `qty: v.number()`. Coerce before writing.

If you want the schema to remain documentation only and not gate writes,
remove `dbValidation: true` from `defineModel`. If you want to skip
validation for a one-off operation, use an aggregation-pipeline update
(`updateOne(filter, [{$set: {...}}])`) — pipeline updates are intentionally
skipped by the validator.

Note: `dbValidation` only fires on writes that go through the autoStamp
wrapper, i.e. handler-driven `db.model(name).<write>` calls inside a
mutation. Sync-push writes (`pushChanges`) bypass the wrapper and use the
policy `transform` callback instead — see the sync guide.

## Sync: client docs missing fields after pull

The model's `clientFields` allowlist is dropping them. The sync engine
projects pulls to `clientFields ∪ {_id, createdAt, updatedAt, deletedAt}`.
Either add the field to `clientFields`, or remove the option entirely if no
restriction is needed.

## Multi-DB: resolver runs but `ctx.db` is the default

The resolver only fires when `ctx.db` entering the handler is the singleton (`DB`). If a caller (a custom HTTP route, a test, or a recursive `ctx.runQuery` / `ctx.runMutation`) passes a different `db` value, the resolver is skipped. Recursive `ctx.runQuery`/`ctx.runMutation` calls also set `_resolved: true` internally so the resolver fires only once per request — that's intentional.

Other causes:

1. The resolver returned `null` / `undefined` for this request (intentional fallback to `MONGO_DB`). Log the resolver input/output to confirm.
2. The resolver threw — the error is wrapped as `DB resolver threw <err>` and surfaced to the caller. Check server logs.
3. The route handler isn't passing `headers` into the ctx. The scaffolded `app/api/handlers/route.ts` and `attachMogobaseWebSocket` both pass `headers` automatically; custom transports must too.

## Multi-DB: `ctx.useDatabase requires the server runtime`

The handler is running in the browser (offline / sync mode) and called `ctx.useDatabase` or `ctx.useRawDatabase`. Both APIs are server-only — guard them behind `if (isServer())` from `mogobase/runtime`, or factor the multi-DB read into a separate handler that only runs on the server.

## Multi-DB: `Raw database "X" is not registered`

`ctx.useRawDatabase("X")` was called without a matching `DB.registerDatabase("X", { uri, dbName })` at boot. Make sure the `registerDatabase` call lives in a module that `server.ts` actually imports — a top-level `import "./mogobase/databases"` at the top of `server.ts` is the simplest wiring.

## Multi-DB: writes on `ctx.useDatabase(...)` aren't stamped

Confirm the call is inside a **mutation** handler, not a query. `ctx.useDatabase` in a mutation returns an autoStamp-wrapped view; in a query it's unwrapped (queries don't stamp anything). If you need stamped writes from a query path, refactor into an `internalMutation` and invoke it via `ctx.runMutation("internal.<name>", args)`.

## Time-series: `Model "X" is a time-series collection. Sync is not supported`

`defineModel(name, schema, { timeseries: {...} })` was paired with a sync
operation (`pullChanges`, `pushChanges`, or `streamChanges`). Sync requires
soft-delete tombstones, which time-series collections can't carry — the two
are mutually exclusive. Either:

- Use a regular collection for that data and index `(timeField, metaField)` yourself, or
- Keep the model as a time-series collection and access it only via online queries / mutations.

## Time-series: `defineModel` throws "incompatible with `timeseries`"

You passed both `sync: true` and `timeseries` to `defineModel`. Drop one:
sync-mode and time-series are mutually exclusive. See "Time-series collections"
in the models guide for context.

## Time-series: insert fails with `'ts' must be present and contain a valid BSON UTC datetime value`

The `timeField` you declared on the model isn't present (or isn't a JS `Date`)
in the inserted document. MongoDB requires the field on every insert. Make
sure you're passing `new Date(...)` for that field, not a number / ISO string.

## Time-series: collection wasn't created with timeseries options

A non-timeseries collection with the same name already exists in MongoDB —
`createCollection` errors and mogobase falls back to a regular handle, with
a warning in the server log. Drop or rename the existing collection, then
restart the server.

## Time-series: `mongo-cursor-pagination` returns empty results

`buildFilters` injects `{deletedAt: null}` into every query. On a time-series
collection the `deletedAt` field is never written, but `{deletedAt: null}`
matches documents where the field doesn't exist — so this works. If you've
*manually* set `deletedAt` on some rows (or pulled them from a regular
collection), drop and recreate the collection or filter them out explicitly.

## Changing hooks doesn't take effect

Hooks are copied into `@/hooks` as templates. Edit them directly in your project — changes in `node_modules/mogobase/src/client/hooks` don't propagate.

## General debugging

When a user reports something broken, call these MCP tools in order:

1. `mogobase_check_setup` — confirms the scaffolding is wired up.
2. `mogobase_list_handlers` — confirms the handler is registered and has the expected args schema.
3. `mogobase_list_models` — confirms `defineModel` calls are present.

If all three look right, look at the browser console (WebSocket frames) and server log (handler boot + invocation trace).
