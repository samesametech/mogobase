# mogobase

A lightweight backend runtime for Next.js apps backed by MongoDB, with reactive queries over WebSockets, Convex-style typed handlers, and **offline support** via RxDB or WatermelonDB.

- **Typed handlers** — define `query()` / `mutation()` with zod-validated args.
- **Reactive queries** — `useQuery` / `usePaginatedQuery` hooks subscribe via WebSocket and re-run on MongoDB change streams.
- **Offline mode** — same handlers run in the browser against RxDB/IndexedDB (default) or WatermelonDB/LokiJS when the app is offline. Toggle with `<MogobaseProvider online={...} offlineAdapter="rxdb" | "watermelon">`.
- **One server** — a custom Next.js `server.ts` serves both your app and the mogobase WS endpoint.
- **MongoDB-native** — thin wrapper around the official driver; no ORM, no schema lock-in.
- **MCP server** — ships a Model Context Protocol server (`mogobase mcp`) that teaches AI assistants how to scaffold and extend a mogobase project.

## Install

```bash
yarn add mogobase ws
yarn add -D @types/ws
npx mogobase install
```

`mogobase install` scaffolds the following into your Next.js project:

- `hooks/useQuery.ts`, `hooks/useMutation.ts`, `hooks/usePaginatedQuery.ts`, `hooks/index.ts`
- `src/app/api/handlers/route.ts` (or `app/api/handlers/route.ts` if `src/` is absent)
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
- `ctx.watch(collectionName)` — **queries only**; subscribes the client to change-stream updates on that collection

Use `internalQuery()` / `internalMutation()` for handlers that should only be callable from server code (stored under the `internal.` prefix).

`defineModel(name, schema?, indexes?)` registers a model for both MongoDB (creates the collection, applies indexes) and RxDB (uses the Zod schema to derive a JSON schema). A schema is required for offline mode.

### 2. Wrap your app with `MogobaseProvider`

```tsx
// app/providers.tsx
"use client"
import { MogobaseProvider } from "mogobase/provider"
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
    <MogobaseProvider online={online} handlers={() => import("@/mogobase")}>
      {children}
    </MogobaseProvider>
  )
}
```

- `online={true}` — hooks talk to the server (WebSocket for queries, POST for mutations).
- `online={false}` — handlers run in the browser against the selected offline backend. The chosen backend is **lazy-loaded**, so online-only consumers don't pay the bundle cost.
- `offlineAdapter` — `"rxdb"` (default; RxDB + Dexie/IndexedDB) or `"watermelon"` (WatermelonDB + LokiJS/IncrementalIDB). Install the matching peer dep for whichever you pick — `rxdb` is bundled, `@nozbe/watermelondb` is an optional peer:
  ```bash
  # watermelon backend only
  yarn add @nozbe/watermelondb
  ```
  Both backends expose the same Mongo-shaped `ctx.db.model(...)` surface, so handler code doesn't change.
- `handlers` — an async loader that imports your `./mogobase` folder so handler registrations run on the client.

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

The hooks branch on the provider's `online` flag: online they use WebSocket + HTTP, offline they run the same handlers against the selected offline backend (RxDB or WatermelonDB) and subscribe to local change events via `clientDB.observeChanges(name)`. Your component code doesn't change.

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
| `mogobase/runtime`     | handler files  | Isomorphic `query`, `mutation`, `defineModel`, `v`     |
| `mogobase/provider`    | client         | `MogobaseProvider`, `useMogobase`                      |
| `mogobase/server`      | server only    | Lower-level registration + `runQuery` / `runMutation`  |
| `mogobase/db`          | server only    | `MogobaseDB` singleton and `Id` / `buildFilters`       |
| `mogobase/client-db`   | client only    | RxDB-backed `ClientDB` (used internally by provider)   |
| `mogobase/client-db/watermelon` | client only | WatermelonDB-backed `ClientDB` (used internally by provider) |

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
| `mogobase://guide/troubleshooting` | Common errors: WS not connecting, handlers not registering, offline gotchas. |

### Prompts

- `setup-mogobase` — seeds the assistant with the correct onboarding workflow: run `mogobase_check_setup`, read the overview + setup guides, propose changes, ask before running `mogobase_install`.

## License

MIT
