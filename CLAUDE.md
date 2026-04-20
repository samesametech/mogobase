# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this package is

`mogobase` is a dual-purpose npm package:

1. **A library** consumed by other apps — exports a server runtime (`mogobase/server`), a MongoDB wrapper (`mogobase/db`), and React client hooks (`mogobase`).
2. **A CLI** (`bin: mogobase`) for the caller app's workflows — `mogobase dev` runs the dev server from the consumer's `node_modules`, `mogobase install` copies source files (currently React hooks) into the consumer's tree, and `mogobase mcp` launches the bundled Model Context Protocol server over stdio so AI assistants can drive scaffolding/inspection.

The build output is published as ESM (`"type": "module"`, `exports` map). Sources use TS path alias `@/*` → `./src/*`; `tsc-alias` rewrites these in `lib/` after `tsc`.

## Commands

- `npm run build` — clean `lib/` and compile (`tsc && tsc-alias`), then copy `src/mcp/guides/*.md` into `lib/mcp/guides/` (the MCP resource loader reads them from there at runtime). Runs automatically via `prepublish`.
- `npm run dev` — `wrangler dev` (Cloudflare Workers entrypoint, separate from the Node dev path used by consumers).
- `npm start` — `node lib/server/start.js` (Node runtime).
- `npm run cf-typegen` — regenerate `CloudflareBindings` types from `wrangler.jsonc`.

There are no tests or linters configured. Do not add CI/lint/test tooling without being asked.

## Architecture

### Server (`src/server/`)

- `handlers.ts` — singleton `Handlers` class holds four maps: public `queries`/`mutations` and internal `_queries`/`_mutations`. Public registration uses `query()` / `mutation()`; internal uses `internalQuery()` / `internalMutation()` (stored with `internal.` prefix). Args are zod v4 schemas validated via `safeParseAsync` before calling the handler. The `v` export is `zod/v4`. Public `runQuery`/`runMutation` are thin wrappers over the singleton's `_runQuery`/`_runMutation` — use these from the Next.js route template.
- Handler `ctx` always includes `db`, `runQuery`, `runMutation`, `headers`, and (for queries) `watch`. `runQuery`/`runMutation` bind back into the singleton so handlers can invoke each other, including `internal.*` names. The `watch` signature is `(modelName, filterOrPipeline?, options?) => void` where `options` extends `ChangeStreamOptions` with `{ paginatedField, sortAscending }` — these two fields are consumed by the paginated WS path to scope the subscription to the loaded page window.
- `matchFilter.ts` — small JS-side Mongo matcher (subset: `$eq`/`$ne`/`$in`/`$nin`/`$gt`/`$gte`/`$lt`/`$lte`/`$and`/`$or`/`$not`/dot paths). Used by `attachWs.ts` to decide whether a change-stream doc passes the handler's `ctx.watch(filter)` without hitting Mongo again.
- `attachWs.ts` — `attachMogobaseWebSocket(httpServer, path="/ws")` public helper. Takes the caller's Node `http.Server` and attaches a `ws` `WebSocketServer` for the given upgrade path. Routes incoming `{ type: "query" | "paginated-query" | "paginated-query-load-next" | "paginated-query-load-previous" | "mutation" }` messages through the singleton handlers and pushes back `QueryResult` / `PaginatedQueryResult` / `PaginatedQueryPage` / `AddDoc` / `UpdateDoc` / `RemoveDoc` / `MutationResult` frames. This is what the Next.js custom-server template wires up. Upgrade interception is done via `server.emit` shadowing rather than `server.on("upgrade")` so Next's own upgrade handler doesn't double-respond on our path (which previously corrupted the socket and closed with 1006).
  - `useQuery` path: each `ctx.watch(...)` opens a `DB.model(name).watch()` change stream scoped to the socket; every change triggers a full handler re-run and a fresh `QueryResult` frame.
  - `usePaginatedQuery` path: the server keeps **one** `PaginatedSub` per socket with the loaded page ids + `paginatedField` values, the handler's filter, `hasPrevious` / `hasNext`, and stored `nextCursor` / `previousCursor`. Incoming change-stream events are evaluated via `matchFilter` (local JS Mongo matcher) + `keyInWindow` (min/max of loaded `paginatedField` values, with `lowerOpen` / `upperOpen` derived from `hasPrevious` × `sortAscending`). Matching events emit incremental `AddDoc` / `UpdateDoc` / `RemoveDoc` frames — the handler is **not** re-run on every event. `paginated-query-load-next/previous` calls the same handler with `next` / `previous` cursors populated from `paginationArgs`, extends the id window with the new page, and updates stored cursors.
- `hono.ts` — legacy HTTP app used by the standalone dev server (`mogobase dev`). Same `/api/handlers` GET/POST shape.
- `ws.ts` — legacy Hono WebSocket wiring used by `mogobase dev`. Same message protocol as `attachWs.ts`.
- `start.ts` — Node entry for `mogobase dev`. Loads `.env` / `.env.local` from cwd, scans `./mogobase/` for `.ts` files, imports each, and calls its default export with the Hono `app`. Port from `MOGOBASE_PORT` (default `4000`). **This is only used when consumers want a standalone mogobase server — the Next.js path (`server.ts` template) replaces this.**

### DB (`src/db/`)

- `index.ts` — `MogobaseDB` singleton. `connect()` uses `MONGO_URI` / `MONGO_DB` (defaults `mongodb://localhost:27017` / `mogobase`). `defineModel(name, schema?, indexes?)` creates the collection if missing, stores the schema in `_schemas`, and applies indexes. Exports: default singleton, `Id` (`ObjectId`), `buildFilters` (from `buildMongoFilters`), and `DataLoaderGenerate(model, key="_id")` for batched lookups.

### Client (`src/client/`)

- `hooks/` — React hooks (`useQuery`, `useMutation`, `usePaginatedQuery`). `useMutation` POSTs to `/api/handlers`; `useQuery`/`usePaginatedQuery` open a native `WebSocket` to `/ws` when online, and when offline fall back to running the handlers directly against the provider's `clientDB`, re-running on `clientDB.observeChanges(collectionName)` events. URLs are same-origin (derived from `window.location`), with `NEXT_MOGOBASE_URL` / `MOGOBASE_URL` env override for SSR or split-origin deploys. Also compiled into `lib/` and re-exported from the package root.
- `provider.ts` — `MogobaseProvider` / `useMogobase` context. Takes `online`, `handlers` (async loader), `dbName`, and `offlineAdapter` (`"rxdb"` default | `"watermelon"`). When `online={false}`, lazy-imports the chosen backend (`./db` or `./db/watermelon`), calls `connect(dbName)`, runs the handler loader, then replays `getModels()` from the runtime registry into `clientDB.defineModel(...)`. The selected backend's default export becomes the `clientDB` context value.
- `db/` — pluggable offline backends. The top-level `db/index.ts` re-exports the RxDB backend so `await import("./db")` keeps working.
  - `db/rxdb/` — `MogobaseClientDB` + `RxMongoAdapter` over RxDB + Dexie. `observeChanges(name)` wraps `collection.$` for reactivity.
  - `db/watermelon/` — `MogobaseWatermelonDB` + `WatermelonMongoAdapter` + `filters.ts` (JS-side Mongo matcher + update applier). Each model is one table with `data` (JSON blob) + `deleted_at` (indexed) columns; filters are evaluated in JS on the decoded blob. `observeChanges(name)` wraps `Database.withChangesForTables([name])` and **skips the replay-on-subscribe emission** so `useQuery` doesn't loop on mount. WatermelonDB requires all `defineModel` calls to occur **before** the DB is first accessed; `defineModel` throws if called after `_ensureDb()` for an unknown model, but is idempotent for already-registered models (safe under React strict-mode double-mount).
    - **Cross-tab sync**: unlike RxDB (which has its own BroadcastChannel layer), LokiJS is purely in-memory per tab and doesn't observe IndexedDB peer writes. To fix this, `MogobaseWatermelonDB` opens a `BroadcastChannel("mogobase-watermelon-<dbName>")`. Every adapter mutation (`insertOne`/`insertMany`/`updateOne`/`updateMany`/`deleteOne`/`deleteMany`/`hardDeleteOne`) posts `{ table, op: "upsert", doc }` or `{ table, op: "hardDelete", id }` after writing. Incoming messages are applied through `_applyUpsert` / `_applyHardDelete` on the target adapter — these helpers look up the record by id directly (bypassing the soft-delete filter so a peer's `deletedAt` can travel through), and set `_applyingRemote = true` around the write to prevent echo loops. The resulting Watermelon write fires `withChangesForTables([name])` in the receiving tab so `observeChanges` subscribers (including `useQuery`) refresh naturally. No conflict resolution — last-writer-wins by message order.
- Both backends conform to the same interface: `connect(dbName)`, `defineModel(name, schema?, indexes?)`, `model(name)` → Mongo-shaped adapter, `observeChanges(name)`, default export = singleton. Hooks reach into neither backend's internals.
- `api/handlers/route.ts` — Next.js App Router route template. **In-process**: imports `runQuery` / `runMutation` from `mogobase/server` and the `DB` singleton from `mogobase/db`, calls them directly.
- `server.ts` — Custom Next.js server template. Creates Node `http.Server`, delegates to Next.js `getRequestHandler()`, calls `attachMogobaseWebSocket(server)`, and loads consumer's `./mogobase/*.ts` files at boot to trigger handler registration. This file is excluded from `tsc` compilation (imports `next` which is a peer dep) and shipped as raw source.
- All three (`hooks/`, `api/`, `server.ts`) ship as raw `.ts` source via `files` in `package.json` so `mogobase install` can copy them into the caller.

### Dev CLI (`src/dev/`)

- `index.ts` — `bin` entry. Dispatches on first arg: `dev` spawns `npx tsx watch ./node_modules/mogobase/lib/dev/start.js` in the consumer's cwd; `install` calls `install.ts`; `mcp` dynamically imports `../mcp/start.js` to boot the stdio MCP server.
- `install.ts` — `install(options)` is the callable entrypoint used by both the CLI and the MCP `mogobase_install` tool. Takes `{ cwd?, logger? }` and returns an `InstallSummary` (`created` / `overwritten` / `skipped` / `nextSteps`). Copies three things into the caller's Next.js project:
  1. Hooks → prefers existing `src/hooks/` or `hooks/`, else creates `src/hooks/` (or `hooks/` if no `src/`). Rewrites relative imports (`../provider`, `../../runtime`) to package imports via `rewriteHookImports`.
  2. API route → installs to `src/app/api/handlers/route.ts` if `src/app/` exists, else `app/api/handlers/route.ts`.
  3. Custom server → `server.ts` at project root.
  Also creates `./mogobase/` folder for consumer's handler files. Files are **overwritten unconditionally** — no interactive prompting; call `mogobase_check_setup` first (or inspect before running) to avoid clobbering.
- Path resolution: `resolveMogobaseRoot()` probes `../..` and `../../..` relative to the running module so it works both from `lib/dev/` in a published install and from source during local tests.

### MCP server (`src/mcp/`)

- `start.ts` — boots an `McpServer` from `@modelcontextprotocol/sdk` with `{ resources, tools, prompts }` capabilities and connects it over `StdioServerTransport`. Name/version come from `readPackageVersion()` (reads the installed `mogobase` `package.json`). Entered via `mogobase mcp`.
- `tools/index.ts` — registers five tools:
  - `mogobase_install` — thin wrapper around `install()` from `src/dev/install.ts`; captures `logger` lines and returns them alongside the `InstallSummary`.
  - `mogobase_check_setup` — reports project type, presence of `server.ts` / route handler / `./mogobase/` / `<MogobaseProvider>` mount, `package.json` scripts+deps, and `MONGO_URI` / `MONGO_DB` across `.env*` files. Non-destructive; always call this before `mogobase_install`.
  - `mogobase_list_handlers` / `mogobase_list_models` — use `parseHandlers.ts` (a regex/AST-light scanner over `./mogobase/*.ts`) to enumerate `query`/`mutation`/`internalQuery`/`internalMutation` calls and `defineModel` calls with file + line.
  - `mogobase_inspect_handler` — returns ~30 lines of source context around a named handler. Accepts either `name` or `internal.name`.
- `resources.ts` — registers eight markdown guides at `mogobase://guide/<slug>` (`overview`, `setup`, `handlers`, `models`, `hooks`, `provider`, `offline-backends`, `troubleshooting`). Reads from `lib/mcp/guides/` when installed, falls back to `src/mcp/guides/` during local dev — so the build script must copy `src/mcp/guides/*.md` into `lib/mcp/guides/`.
- `prompts.ts` — registers one prompt, `setup-mogobase`, that seeds the assistant with the correct onboarding workflow (check setup → read guides → propose + confirm → install).
- `guides/*.md` — source of truth for the long-form explanations surfaced via MCP resources. Prefer editing these over inlining large blocks of prose into tool descriptions.
- When adding a new tool, register it from `tools/index.ts` and keep the tool name prefixed with `mogobase_` for easy disambiguation in the MCP client. When adding a new guide, update the `GUIDES` array in `resources.ts` **and** ensure the `.md` file lands in `lib/mcp/guides/` via the build script (no separate `files` entry is needed — the copy step places it inside `lib/`).

### How a consumer uses this package (Next.js App Router)

1. `yarn add mogobase ws` and `yarn add -D @types/ws`. For the WatermelonDB offline backend, also `yarn add @nozbe/watermelondb` (optional peer dep).
2. `npx mogobase install` — copies hooks, `app/api/handlers/route.ts`, and `server.ts`; creates `./mogobase/`.
3. Update `package.json` scripts: `"dev": "tsx server.ts"`, `"start": "NODE_ENV=production tsx server.ts"`.
4. Add handler files in `./mogobase/*.ts` that call `query()`/`mutation()` at module scope.
5. Set `MONGO_URI` / `MONGO_DB` in `.env.local`.

## Conventions specific to this repo

- Singletons are the norm (`Handlers`, `MogobaseDB`, `WebSocket`). Do not introduce per-request instances without a clear reason — existing code relies on the singletons being shared across `hono.ts`, `ws.ts`, and consumer-registered handlers.
- Handler names beginning with `internal` are routed to the `_queries`/`_mutations` maps and stored with an `internal.` prefix — preserve this behavior when editing `handlers.ts`.
- When adding files that must be shipped as source (not compiled), update the `files` array in `package.json` — compiled output only covers what `tsc` emits into `lib/`.
- The `baseUrl`/`rootDir` deprecation warnings from `tsc` are pre-existing and do not block `build`; leave them alone unless explicitly asked to migrate.
