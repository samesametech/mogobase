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

## Watermelon install reports peer dep warning

`mogobase` declares `@nozbe/watermelondb` as an optional peer dep. If you're using the RxDB backend, ignore the warning. If you picked WatermelonDB, `yarn add @nozbe/watermelondb`.

## Paginated query: doc changes aren't pushed

`usePaginatedQuery` relies on the handler calling `ctx.watch(modelName, filter, { paginatedField, sortAscending })`. Without the filter + options, the server can't decide whether a change-stream event belongs to the loaded window, so diffs are dropped. Pass the **same filter** you pass to `MongoPaging.find`, and pass `paginatedField` / `sortAscending` from `args.paginationArgs`.

## Paginated query: only `_id` sort works

The server's window-matching is keyed on `paginatedField`. If your handler sorts/cursors on a different field, you must pass `{ paginatedField: "createdAt" }` (or whatever) to `ctx.watch` — otherwise the server tracks `_id` values which won't match the page boundaries.

## Offline: tab B doesn't see writes from tab A

Both tabs must be using the same `dbName` on the `MogobaseProvider`. If different names are in play, the BroadcastChannel topic (`mogobase-watermelon-<dbName>` or the RxDB equivalent) is different and messages aren't shared. Also confirm you're not in a context where `BroadcastChannel` is unavailable (older browsers, some WebView embeddings).

## Changing hooks doesn't take effect

Hooks are copied into `@/hooks` as templates. Edit them directly in your project — changes in `node_modules/mogobase/src/client/hooks` don't propagate.

## General debugging

When a user reports something broken, call these MCP tools in order:

1. `mogobase_check_setup` — confirms the scaffolding is wired up.
2. `mogobase_list_handlers` — confirms the handler is registered and has the expected args schema.
3. `mogobase_list_models` — confirms `defineModel` calls are present.

If all three look right, look at the browser console (WebSocket frames) and server log (handler boot + invocation trace).
