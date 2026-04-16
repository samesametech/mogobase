# Mogobase Overview

Mogobase is a Next.js-focused backend layer that combines MongoDB persistence, a typed query/mutation handler system, WebSocket live queries, and an optional offline-first client store (RxDB or WatermelonDB).

## What it gives you

- **Handlers**: `query()` / `mutation()` / `internalQuery()` / `internalMutation()` registered at module scope in `./mogobase/*.ts`. Zod v4 args, typed context with `db`, `runQuery`, `runMutation`, `headers`, and `watch` (queries only).
- **MongoDB wrapper**: `MogobaseDB` singleton with `defineModel(name, schema?, indexes?)`, `Id` (`ObjectId`), `buildFilters`, and `DataLoaderGenerate` for batched reads.
- **Live queries over WebSocket**: `attachMogobaseWebSocket(httpServer)` in the custom `server.ts`. The client `useQuery` / `usePaginatedQuery` hooks subscribe over `/ws` and get pushed `UpdateDoc` frames.
- **Offline mode**: wrap the app in `<MogobaseProvider online={false}>`. Hooks run handlers directly against a local store and re-run on change events. Two interchangeable backends: `rxdb` (default) or `watermelon`.
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

See the other guides for detailed patterns: `setup`, `handlers`, `models`, `hooks`, `provider`, `offline-backends`, `troubleshooting`.
