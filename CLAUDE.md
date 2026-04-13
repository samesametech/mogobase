# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this package is

`mogobase` is a dual-purpose npm package:

1. **A library** consumed by other apps — exports a server runtime (`mogobase/server`), a MongoDB wrapper (`mogobase/db`), and React client hooks (`mogobase`).
2. **A CLI** (`bin: mogobase`) for the caller app's workflows — `mogobase dev` runs the dev server from the consumer's `node_modules`, and `mogobase install` copies source files (currently React hooks) into the consumer's tree.

The build output is published as ESM (`"type": "module"`, `exports` map). Sources use TS path alias `@/*` → `./src/*`; `tsc-alias` rewrites these in `lib/` after `tsc`.

## Commands

- `npm run build` — clean `lib/` and compile (`tsc && tsc-alias`). Runs automatically via `prepublish`.
- `npm run dev` — `wrangler dev` (Cloudflare Workers entrypoint, separate from the Node dev path used by consumers).
- `npm start` — `node lib/server/start.js` (Node runtime).
- `npm run cf-typegen` — regenerate `CloudflareBindings` types from `wrangler.jsonc`.

There are no tests or linters configured. Do not add CI/lint/test tooling without being asked.

## Architecture

### Server (`src/server/`)

- `handlers.ts` — singleton `Handlers` class holds four maps: public `queries`/`mutations` and internal `_queries`/`_mutations`. Public registration uses `query()` / `mutation()`; internal uses `internalQuery()` / `internalMutation()` (stored with `internal.` prefix). Args are zod v4 schemas validated via `safeParseAsync` before calling the handler. The `v` export is `zod/v4`. Public `runQuery`/`runMutation` are thin wrappers over the singleton's `_runQuery`/`_runMutation` — use these from the Next.js route template.
- Handler `ctx` always includes `db`, `runQuery`, `runMutation`, `headers`, and (for queries) `watch`. `runQuery`/`runMutation` bind back into the singleton so handlers can invoke each other, including `internal.*` names.
- `attachWs.ts` — `attachMogobaseWebSocket(httpServer, path="/ws")` public helper. Takes the caller's Node `http.Server` and attaches a `ws` `WebSocketServer` for the given upgrade path. Routes incoming `{ type: "query" | "paginated-query" | "mutation" }` messages through the singleton handlers, manages per-socket change-stream state (with `resumeToken`), pushes `QueryResult`/`PaginatedQueryResult`/`UpdateDoc`/`MutationResult` frames. This is what the Next.js custom-server template wires up.
- `hono.ts` — legacy HTTP app used by the standalone dev server (`mogobase dev`). Same `/api/handlers` GET/POST shape.
- `ws.ts` — legacy Hono WebSocket wiring used by `mogobase dev`. Same message protocol as `attachWs.ts`.
- `start.ts` — Node entry for `mogobase dev`. Loads `.env` / `.env.local` from cwd, scans `./mogobase/` for `.ts` files, imports each, and calls its default export with the Hono `app`. Port from `MOGOBASE_PORT` (default `4000`). **This is only used when consumers want a standalone mogobase server — the Next.js path (`server.ts` template) replaces this.**

### DB (`src/db/`)

- `index.ts` — `MogobaseDB` singleton. `connect()` uses `MONGO_URI` / `MONGO_DB` (defaults `mongodb://localhost:27017` / `mogobase`). `defineModel(name, schema?, indexes?)` creates the collection if missing, stores the schema in `_schemas`, and applies indexes. Exports: default singleton, `Id` (`ObjectId`), `buildFilters` (from `buildMongoFilters`), and `DataLoaderGenerate(model, key="_id")` for batched lookups.

### Client (`src/client/`)

- `hooks/` — React hooks (`useQuery`, `useMutation`, `usePaginatedQuery`). `useMutation` POSTs to `/api/handlers`; `useQuery`/`usePaginatedQuery` open a native `WebSocket` to `/ws`. URLs are same-origin (derived from `window.location`), with `NEXT_MOGOBASE_URL` / `MOGOBASE_URL` env override for SSR or split-origin deploys. Also compiled into `lib/` and re-exported from the package root.
- `api/handlers/route.ts` — Next.js App Router route template. **In-process**: imports `runQuery` / `runMutation` from `mogobase/server` and the `DB` singleton from `mogobase/db`, calls them directly.
- `server.ts` — Custom Next.js server template. Creates Node `http.Server`, delegates to Next.js `getRequestHandler()`, calls `attachMogobaseWebSocket(server)`, and loads consumer's `./mogobase/*.ts` files at boot to trigger handler registration. This file is excluded from `tsc` compilation (imports `next` which is a peer dep) and shipped as raw source.
- All three (`hooks/`, `api/`, `server.ts`) ship as raw `.ts` source via `files` in `package.json` so `mogobase install` can copy them into the caller.

### Dev CLI (`src/dev/`)

- `index.ts` — `bin` entry. Dispatches on first arg: `dev` spawns `npx tsx watch ./node_modules/mogobase/lib/dev/start.js` in the consumer's cwd; `install` calls `install.ts`.
- `install.ts` — copies three things into the caller's Next.js project:
  1. Hooks → BFS-finds the shallowest `hooks/` folder (or creates `./hooks/`), skipping `node_modules`/`.git`/`dist`/`build`/`.next`/`.turbo`/`.cache`/`out`/`coverage`.
  2. API route → installs to `src/app/api/handlers/route.ts` if `src/app/` exists, else `app/api/handlers/route.ts`.
  3. Custom server → `server.ts` at project root.
  Also creates `./mogobase/` folder for consumer's handler files. On per-file conflict, prompts `o/s/oa/sa` via a shared `Installer` helper.
- Path resolution: `resolveMogobaseRoot()` probes `../..` and `../../..` relative to the running module so it works both from `lib/dev/` in a published install and from source during local tests.

### How a consumer uses this package (Next.js App Router)

1. `yarn add mogobase ws` and `yarn add -D @types/ws`.
2. `npx mogobase install` — copies hooks, `app/api/handlers/route.ts`, and `server.ts`; creates `./mogobase/`.
3. Update `package.json` scripts: `"dev": "tsx server.ts"`, `"start": "NODE_ENV=production tsx server.ts"`.
4. Add handler files in `./mogobase/*.ts` that call `query()`/`mutation()` at module scope.
5. Set `MONGO_URI` / `MONGO_DB` in `.env.local`.

## Conventions specific to this repo

- Singletons are the norm (`Handlers`, `MogobaseDB`, `WebSocket`). Do not introduce per-request instances without a clear reason — existing code relies on the singletons being shared across `hono.ts`, `ws.ts`, and consumer-registered handlers.
- Handler names beginning with `internal` are routed to the `_queries`/`_mutations` maps and stored with an `internal.` prefix — preserve this behavior when editing `handlers.ts`.
- When adding files that must be shipped as source (not compiled), update the `files` array in `package.json` — compiled output only covers what `tsc` emits into `lib/`.
- The `baseUrl`/`rootDir` deprecation warnings from `tsc` are pre-existing and do not block `build`; leave them alone unless explicitly asked to migrate.
