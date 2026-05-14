# Mogobase Overview

Mogobase is a Next.js-focused backend layer that combines MongoDB persistence, a typed query/mutation handler system, WebSocket live queries, and an optional offline-first client store (RxDB or WatermelonDB).

## What it gives you

- **Handlers**: `query()` / `mutation()` / `internalQuery()` / `internalMutation()` registered at module scope in `./mogobase/*.ts`. Zod v4 args, typed context with `db`, `runQuery`, `runMutation`, `headers`, and `watch` (queries only).
- **MongoDB wrapper**: `MogobaseDB` singleton with `defineModel(name, schema?, options?)`, `Id` (`ObjectId`), `buildFilters`, and `DataLoaderGenerate` for batched reads. `defineModel` options include `clientFields` (visibility allowlist), `sync: true` (default-deny sync opt-in), `dbValidation: true` (zod-validate writes), and `timeseries: { timeField, … }` (create the underlying collection as a MongoDB time-series collection).
- **Live queries over WebSocket**: `attachMogobaseWebSocket(httpServer)` in the custom `server.ts`. `useQuery` re-runs its handler on every matching change-stream event; `usePaginatedQuery` refetches the full loaded window on any `ctx.watch`-registered change — so both queries and paginated lists stay live, including enrichments from joined collections.
- **Offline mode (opt-in)**: import an offline-store singleton (`mogobase/client-db` for RxDB, `mogobase/client-db/watermelon` for WatermelonDB) and pass it as `<MogobaseProvider clientDB={…}>`. Hooks run handlers directly against the local store and re-run on change events. Both backends are **optional peer dependencies** — an online-only app installs neither. Both propagate writes across same-origin tabs — RxDB via its built-in BroadcastChannel, WatermelonDB via a `BroadcastChannel("mogobase-watermelon-<dbName>")` shim provided by mogobase.
- **Local-first sync (opt-in)**: `online + sync` mode replicates clientDB ↔ MongoDB over `/ws` (or `/api/sync` fallback). Security is layered: default-deny model allowlist (`sync: true` per model), `clientFields` projection on pull and strip on push, per-op `SyncPolicy` callback for `allow`/`filter`/`transform`, server-owned timestamps, and a 500-row push batch cap. See `mogobase://guide/sync`.
- **`filterClientFields(model, input)`**: utility from `mogobase/runtime` for online handlers to strip server-only fields out of return values using the same `clientFields` allowlist used by sync.
- **Multi-database handlers (server only)**: `DB.setRequestResolver(...)` for per-request tenant routing on the same cluster, `ctx.useDatabase(dbName)` for explicit per-handler DB selection, and `DB.registerDatabase(...)` + `ctx.useRawDatabase(name)` for cross-cluster reads. Schemas are shared across views; indexes apply lazily per (DB, model). Sync stays bound to the default DB. See `mogobase://guide/handlers` → "Multi-database access".
- **CLI**: `mogobase install` scaffolds the consumer's Next.js project; `mogobase mcp` runs this MCP server; `mogobase dev` runs a standalone Hono server (legacy, not needed for the Next.js path).

## The Next.js setup at a glance

1. `yarn add mogobase ws && yarn add -D @types/ws`
2. `npx mogobase install` — writes hooks, `app/api/handlers/route.ts`, `server.ts`, creates `./mogobase/`.
3. `"dev": "tsx server.ts"`, `"start": "NODE_ENV=production tsx server.ts"` in package.json.
4. Write handlers in `./mogobase/*.ts` — each file runs `query()`/`mutation()` calls at module scope.
5. Set `MONGO_URI` and `MONGO_DB` in `.env.local`.
6. Use `useQuery`/`useMutation`/`usePaginatedQuery` from the copied `@/hooks`.

## Important concepts

- **Singletons are the norm** — `Handlers`, `MogobaseDB`, the WebSocket server. Handlers registered in one module are visible to the whole app because they share a singleton map.
- **Isomorphic handler files** — handler files import from `"mogobase/runtime"` and work on both server and client (for offline replay). Do NOT import Node-only modules inside handler files.
- **Names starting with `internal`** are routed to internal maps and stored with an `internal.` prefix. Only callable via `ctx.runQuery("internal.foo")` / `ctx.runMutation("internal.foo")` — not exposed to clients.
- **Offline-mode model registration order matters for WatermelonDB**: all `defineModel` calls must occur before the DB is first accessed.

See the other guides for detailed patterns: `setup`, `handlers`, `models`, `hooks`, `provider`, `offline-backends`, `sync`, `troubleshooting`.
