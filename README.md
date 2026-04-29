# mogobase

A lightweight backend runtime for Next.js apps backed by MongoDB, with reactive queries over WebSockets, Convex-style typed handlers, **opt-in offline support** via RxDB or WatermelonDB, and **opt-in local-first sync** that keeps the client store and MongoDB continuously replicated.

Source: [github.com/samesametech/mogobase](https://github.com/samesametech/mogobase) · npm: [`mogobase`](https://www.npmjs.com/package/mogobase)

- **Typed handlers** — define `query()` / `mutation()` with zod-validated args.
- **Reactive queries** — `useQuery` and `usePaginatedQuery` both re-run their handlers on MongoDB change stream events. For `usePaginatedQuery` the server reuses the currently-loaded window as the effective limit so scroll position is preserved across refetches, and enrichments from joined collections (watched with additional `ctx.watch` calls) stay fresh.
- **Offline mode is opt-in** — same handlers run in the browser against RxDB/IndexedDB or WatermelonDB/LokiJS. The consumer imports the backend they want and passes it as `<MogobaseProvider clientDB={…}>`. Online-only apps install neither offline package — `rxdb` and `@nozbe/watermelondb` are both optional peer dependencies. Both backends sync writes across same-origin tabs via BroadcastChannel.
- **Local-first sync is opt-in** — turn on `sync={true}` and the same hooks read/write through `clientDB` while a background engine continuously replicates with MongoDB over the existing `/ws` connection. Writes pushed up; server changes streamed down; offline writes queue locally and replay when the WS reconnects.
- **Sync security is built in** — default-deny model allowlist (`sync: true` per model), `clientFields` projection (server-only fields never reach the client; clients can't write outside the allowlist), per-op `SyncPolicy` callback for allow/filter/transform with the request headers, server-owned timestamps, and a 500-row push batch cap.
- **One server** — a custom Next.js `server.ts` serves both your app and the mogobase WS endpoint.
- **MongoDB-native** — thin wrapper around the official driver; no ORM, no schema lock-in.
- **MCP server** — ships a Model Context Protocol server (`mogobase mcp`) that teaches AI assistants how to scaffold and extend a mogobase project.

## Install

```bash
yarn add mogobase ws
yarn add -D @types/ws
npx mogobase install
```

For offline mode, also install the backend you want — neither is needed for online-only apps:

```bash
# RxDB backend (Dexie/IndexedDB)
yarn add rxdb

# OR WatermelonDB backend (LokiJS)
yarn add @nozbe/watermelondb
```

`mogobase install` scaffolds the following into your Next.js project:

- `hooks/useQuery.ts`, `hooks/useMutation.ts`, `hooks/usePaginatedQuery.ts`, `hooks/index.ts`
- `src/app/api/handlers/route.ts` (or `app/api/handlers/route.ts` if `src/` is absent)
- `src/app/api/sync/route.ts` — HTTP-fallback for sync mode (harmless if you don't use sync)
- `server.ts` at the project root
- `mogobase/` folder for your handler files

Update your `package.json` scripts:

```json
{
  "scripts": {
    "dev": "tsx server.ts",
    "build": "next build",
    "start": "NODE_ENV=production tsx server.ts"
  }
}
```

Set Mongo connection env vars in `.env.local`:

```bash
MONGO_URI=mongodb://localhost:27017
MONGO_DB=myapp
```

## Usage

### 1. Define handlers (isomorphic)

Create files in `./mogobase/`. Each file is auto-loaded at server boot, and re-used in the browser when offline mode is active. **Import everything from `mogobase/runtime`** — it's browser-safe and has no `mongodb` / `ws` imports.

```ts
// mogobase/tasks.ts
import { query, mutation, defineModel, v } from "mogobase/runtime"

defineModel(
  "tasks",
  v.object({
    _id: v.string(),
    title: v.string(),
    done: v.boolean(),
  })
)

query("listTasks", {
  args: v.object({}),
  handler: async (_args, ctx) => {
    ctx.watch("tasks") // subscribe this query to the "tasks" collection
    const docs = await ctx.db.model("tasks").find({}).sort({ _id: -1 }).toArray()
    return docs.map((d) => ({ _id: String(d._id), title: d.title, done: !!d.done }))
  },
})

mutation("createTask", {
  args: v.object({ title: v.string().min(1) }),
  handler: async ({ title }, ctx) => {
    const { insertedId } = await ctx.db.model("tasks").insertOne({ title, done: false })
    return { _id: String(insertedId), title, done: false }
  },
})

mutation("toggleTask", {
  args: v.object({ id: v.string(), done: v.boolean() }),
  handler: async ({ id, done }, ctx) => {
    await ctx.db.model("tasks").updateOne({ _id: id }, { $set: { done } })
    return { ok: true }
  },
})
```

Handler `ctx` provides:

- `ctx.db` — the database (MongoDB server-side, RxDB offline). `ctx.db.model(name)` returns a collection-like object with `find`, `insertOne`, `updateOne`, etc.
- `ctx.runQuery(name, args)` / `ctx.runMutation(name, args)` — call other handlers, including `internal.*`
- `ctx.headers` — request headers (useful for auth; online only)
- `ctx.watch(modelName, pipeline?, options?)` — **queries only**. Subscribes the client to change-stream updates on that collection. Triggers a full handler re-run on every matching event for both `useQuery` and `usePaginatedQuery`. Pass an aggregation pipeline as the second argument for server-side pre-filtering; the third argument forwards to `collection.watch(pipeline, options)` as `ChangeStreamOptions`.

Use `internalQuery()` / `internalMutation()` for handlers that should only be callable from server code (stored under the `internal.` prefix).

`defineModel(name, schema?, options?)` registers a model for both MongoDB (creates the collection, applies indexes) and RxDB (uses the Zod schema to derive a JSON schema). A schema is required for offline mode. Useful options:

- `indexSpecs` — passed to `createIndexes`. The engine always adds `updatedAt`, `deletedAt`, `createdAt` indexes (sync depends on them) on top of yours.
- `clientFields: string[]` — visibility allowlist. Used by `filterClientFields(model, doc)` (online flow) and the sync engine (pull projection + push allowlist). Engine fields (`_id`, `createdAt`, `updatedAt`, `deletedAt`) are always included. Omit for no restriction.
- `sync: true` — opt the model into mogobase sync. Default-deny: pull/push/watch on a model without `sync: true` throws.

### 2. Wrap your app with `MogobaseProvider`

**Online-only** (no offline backend installed):

```tsx
// app/providers.tsx
"use client"
import { MogobaseProvider } from "mogobase/provider"

export function Providers({ children }: { children: React.ReactNode }) {
  return <MogobaseProvider online={true}>{children}</MogobaseProvider>
}
```

**Online + offline** (network-aware, with a backend the consumer imports):

```tsx
// app/providers.tsx
"use client"
import { MogobaseProvider } from "mogobase/provider"
import RxClientDB from "mogobase/client-db" // or "mogobase/client-db/watermelon"
import { useEffect, useState } from "react"

export function Providers({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])

  return (
    <MogobaseProvider online={online} clientDB={RxClientDB} handlers={() => import("@/mogobase")}>
      {children}
    </MogobaseProvider>
  )
}
```

- `online={true}` — hooks talk to the server (WebSocket for queries, POST for mutations). No `clientDB` needed.
- `online={false}` — handlers run in the browser against `clientDB`. The provider throws a clear error if `clientDB` is missing in this mode.
- `online={true}` + `sync={true}` — local-first. Hooks read/write through `clientDB` and a background engine continuously replicates with MongoDB. See the next section.
- `clientDB` — the singleton from `mogobase/client-db` (RxDB) or `mogobase/client-db/watermelon` (WatermelonDB). Whichever subpath you import is the only one that ends up in your bundle, and the matching peer package (`rxdb` or `@nozbe/watermelondb`) is the only one you need to install. Both backends expose the same Mongo-shaped `ctx.db.model(...)` surface, so handler code doesn't change.
- `handlers` — async loader that imports your `./mogobase` folder so handler registrations run on the client. Required for offline and sync modes; safe to omit for online-only.

#### Local-first sync mode

Add `sync={true}` (with `online={true}`) and the same hooks become local-first: every read hits `clientDB`, every write lands locally first and is then pushed to MongoDB. Server changes flow back down through the same `/ws` connection.

```tsx
// app/providers.tsx
"use client"
import { MogobaseProvider } from "mogobase/provider"
import RxClientDB from "mogobase/client-db" // or "mogobase/client-db/watermelon"
import { useMemo } from "react"

const SYNC_OPTIONS = { batchSize: 200 }

export function Providers({ children }: { children: React.ReactNode }) {
  const syncOptions = useMemo(() => SYNC_OPTIONS, [])
  return (
    <MogobaseProvider
      online={true}
      sync={true}
      clientDB={RxClientDB}
      dbName="my-app"
      handlers={() => import("@/mogobase")}
      syncOptions={syncOptions}
    >
      {children}
    </MogobaseProvider>
  )
}
```

What you get:

- Reads are instant (served from IndexedDB / LokiJS).
- Writes don't wait for the network — they replay automatically when the WS reconnects.
- Server changes from other clients land within ~3s via a `sync-stream` event that re-pulls.
- `createdAt` / `updatedAt` / `deletedAt` are auto-injected into every model schema and auto-stamped on every write — handler authors don't have to declare or update them. Timestamps are numeric ms (`Date.now()`). Server timestamps **always override** client values; the client clock is only consulted for conflict ordering.
- Soft-deletes propagate (`deleteOne` is rewritten to `$set: {deletedAt, updatedAt}` so the sync checkpoint can carry tombstones). Reach through to the underlying driver if you really need a hard delete.

#### Securing sync (`SyncPolicy`)

Every pull / push / watch goes through a `SyncPolicy` callback you wire into both transports. Defaults are secure (default-deny). Define the policy once and import it from both places:

```ts
// mogobase/syncPolicy.ts
import type { SyncPolicy } from "mogobase/server"
import { getSession } from "./auth"

export const syncPolicy: SyncPolicy = async ({ model, headers }) => {
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

```ts
// server.ts
import { attachMogobaseWebSocket } from "mogobase/server"
import { syncPolicy } from "./mogobase/syncPolicy"
attachMogobaseWebSocket(server, "/ws", { syncPolicy })
```

```ts
// app/api/sync/route.ts (the scaffolded HTTP fallback)
import { syncPolicy } from "../../../../mogobase/syncPolicy"
```

`filter` is merged into the pull WHERE clause and translated to a change-stream `$match` pipeline — MongoDB only sends notifications for in-scope docs. `transform(doc, existing)` runs once per pushed row; throw to reject (the server's existing doc is returned as a conflict). Combine with `clientFields` on `defineModel` so server-only fields never ship and the push payload is allowlisted.

Caveats:

- `_id` must be a string. Sync mode collections are incompatible with existing `ObjectId` `_id`s.
- Memoize `syncOptions` (or define at module scope). It's in the provider's effect dep array — an inline `{}` will tear down and restart sync on every render.
- A model needs `sync: true` on `defineModel` to be syncable. The server only auto-loads `./mogobase/*.ts`; if you split sync handlers into a separate folder, extend the `loadHandlers()` loop in `server.ts` to load it too — otherwise `sync: true` only registers on the client.
- Don't hard-delete on a synced model with a per-tenant `filter`: change-stream delete events don't carry `fullDocument`, so the `$match` filter drops them and clients miss tombstones.
- WatermelonDB does a full pull per cycle; for >10K records per model the initial sync is slow. RxDB doesn't have this limitation.
- For paginated queries that must work in both modes (server-side Mongo and client-side adapter), use the runtime helpers `isServer()` + `MongoPaging` to dispatch between `mongo-cursor-pagination` (server) and the browser-safe polyfill (client). See `mogobase://guide/handlers` → "Isomorphic handlers".
- See `mogobase://guide/sync` (MCP) for the wire protocol, conflict resolution defaults, and the full list of edge cases.

### 3. Consume from React

```tsx
"use client"
import { useQuery, useMutation } from "@/hooks"

export default function Tasks() {
  const tasks = useQuery("listTasks", {})
  const createTask = useMutation("createTask")
  const toggleTask = useMutation("toggleTask")

  if (!tasks) return <p>Loading…</p>

  return (
    <ul>
      {tasks.map((t) => (
        <li key={t._id}>
          <input
            type="checkbox"
            checked={t.done}
            onChange={(e) => toggleTask({ id: t._id, done: e.target.checked })}
          />
          {t.title}
        </li>
      ))}
      <button onClick={() => createTask({ title: "New task" })}>Add</button>
    </ul>
  )
}
```

The hooks branch on the provider's `online` and `sync` flags: pure-online they use WebSocket + HTTP; offline (or local-first sync) they run the same handlers against the selected backend (RxDB or WatermelonDB) and subscribe to local change events via `clientDB.observeChanges(name)`. Your component code doesn't change.

### 4. Run it

```bash
yarn dev
# > Mogobase + Next.js ready on http://localhost:3000
```

## Configuration

| Env var              | Default                     | Purpose                                      |
| -------------------- | --------------------------- | -------------------------------------------- |
| `MONGO_URI`          | `mongodb://localhost:27017` | MongoDB connection string                    |
| `MONGO_DB`           | `mogobase`                  | Database name                                |
| `MOGOBASE_PORT`      | `4000`                      | Port for the standalone `mogobase dev` server |
| `NEXT_MOGOBASE_URL`  | *(same-origin)*             | Override client WS/HTTP base URL             |
| `MOGOBASE_URL`       | *(same-origin)*             | SSR override for the same                    |

## Package entry points

| Import                 | Use from       | Purpose                                                |
| ---------------------- | -------------- | ------------------------------------------------------ |
| `mogobase/runtime`     | handler files  | Isomorphic `query`, `mutation`, `defineModel`, `v`, `isServer`, `isClient`, `MongoPaging` (browser-safe polyfill of `mongo-cursor-pagination`) |
| `mogobase/provider`    | client         | `MogobaseProvider`, `useMogobase`                      |
| `mogobase/server`      | server only    | Lower-level registration + `runQuery` / `runMutation`  |
| `mogobase/server/sync` | server only    | `pullChanges`, `pushChanges`, `streamChanges` for the `/api/sync` HTTP fallback or custom transports |
| `mogobase/sync-types`  | isomorphic     | Wire-protocol types: `SyncDoc`, `SyncOptions`, `SyncHandle` |
| `mogobase/db`          | server only    | `MogobaseDB` singleton and `Id` / `buildFilters`       |
| `mogobase/client-db`   | client only    | RxDB-backed `ClientDB` singleton — `import` and pass as `clientDB` prop. Requires `rxdb` peer dep. |
| `mogobase/client-db/watermelon` | client only | WatermelonDB-backed `ClientDB` singleton — `import` and pass as `clientDB` prop. Requires `@nozbe/watermelondb` peer dep. |

Prefer `mogobase/runtime` for anything that might run in the browser.

## CLI

- `mogobase install` — scaffold files into the consuming project. Re-run to update; files are overwritten on conflict.
- `mogobase dev` — standalone dev server (Hono-based), used when you don't want to run Next.js. Loads handlers from `./mogobase/*.ts`.
- `mogobase mcp` — starts the bundled MCP server over stdio (see below).

## MCP server

Mogobase ships a [Model Context Protocol](https://modelcontextprotocol.io) server so AI coding assistants (Claude Code, Claude Desktop, Cursor, etc.) can scaffold, inspect, and extend a mogobase project without guessing at conventions.

### Register the server

Run it over stdio with `npx mogobase mcp` from inside the consumer project.

**Claude Code** (from the project root):

```bash
claude mcp add mogobase -- npx -y mogobase mcp
```

**Generic MCP client** (`.mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mogobase": {
      "command": "npx",
      "args": ["-y", "mogobase", "mcp"]
    }
  }
}
```

The server inherits the client's working directory, so tools that read your project (`mogobase_check_setup`, `mogobase_list_handlers`, …) operate on whichever project the MCP client is attached to.

### Tools

| Tool | Purpose |
| ---- | ------- |
| `mogobase_check_setup` | Reports what's wired up vs. missing: project type, `server.ts`, API route, provider mount, handler files, env vars, `package.json` scripts and deps. Call this first. |
| `mogobase_install` | Runs the same scaffolding as `npx mogobase install`. Overwrites on conflict — call `mogobase_check_setup` first. |
| `mogobase_list_handlers` | Parses `./mogobase/*.ts` and lists every `query` / `mutation` / `internalQuery` / `internalMutation` with its file and line. |
| `mogobase_list_models` | Lists every `defineModel(...)` call across the project's handler files. |
| `mogobase_inspect_handler` | Returns ~30 lines of source around a given handler by name (accepts `internal.*`). |

### Resources

Guides are served as `mogobase://guide/<slug>` (markdown). Clients can read them on demand:

| URI | Description |
| --- | ----------- |
| `mogobase://guide/overview` | What mogobase is and the shape of a Next.js setup. |
| `mogobase://guide/setup` | Step-by-step install and wire-up for a Next.js App Router project. |
| `mogobase://guide/handlers` | `query`, `mutation`, `internalQuery`, `internalMutation` — args, ctx, conventions. |
| `mogobase://guide/models` | `defineModel`, zod schemas, indexes, `ObjectId`, `DataLoader`, `buildFilters`. |
| `mogobase://guide/hooks` | `useQuery`, `useMutation`, `usePaginatedQuery` usage and transport model. |
| `mogobase://guide/provider` | Wrapping the app, online/offline flag, handlers loader, boot sequence. |
| `mogobase://guide/offline-backends` | RxDB vs WatermelonDB — when to pick each, caveats, interface. |
| `mogobase://guide/sync` | Local-first sync mode: enabling, wire protocol, `updatedAt` semantics, conflict resolution, soft-delete propagation, known limitations. |
| `mogobase://guide/troubleshooting` | Common errors: WS not connecting, handlers not registering, offline gotchas. |

### Prompts

- `setup-mogobase` — seeds the assistant with the correct onboarding workflow: run `mogobase_check_setup`, read the overview + setup guides, propose changes, ask before running `mogobase_install`.

## License

MIT
