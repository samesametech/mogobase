# mogobase

A lightweight backend runtime for Next.js apps backed by MongoDB, with reactive queries over WebSockets and Convex-style typed handlers.

- **Typed handlers** — define `query()` / `mutation()` with zod-validated args.
- **Reactive queries** — `useQuery` / `usePaginatedQuery` hooks subscribe via WebSocket and re-run on MongoDB change streams.
- **One server** — a custom Next.js `server.ts` serves both your app and the mogobase WS endpoint.
- **MongoDB-native** — thin wrapper around the official driver; no ORM, no schema lock-in.

## Install

```bash
yarn add mogobase ws
yarn add -D @types/ws
npx mogobase install
```

`mogobase install` scaffolds the following into your Next.js project:

- `hooks/useQuery.ts`, `hooks/useMutation.ts`, `hooks/usePaginatedQuery.ts`
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

### 1. Define handlers

Create files in `./mogobase/`. Each file is auto-loaded at server boot.

```ts
// mogobase/tasks.ts
import { query, mutation, v } from "mogobase/server"
import DB, { Id } from "mogobase/db"

DB.defineModel("tasks")

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
    await ctx.db.model("tasks").updateOne({ _id: new Id(id) }, { $set: { done } })
    return { ok: true }
  },
})
```

Handler `ctx` provides:

- `ctx.db` — the `MogobaseDB` singleton (`ctx.db.model(name)` returns a MongoDB `Collection`)
- `ctx.runQuery(name, args)` / `ctx.runMutation(name, args)` — call other handlers, including `internal.*`
- `ctx.headers` — request headers (useful for auth)
- `ctx.watch(collectionName)` — **queries only**; subscribes the WebSocket client to change-stream updates on that collection

Use `internalQuery()` / `internalMutation()` for handlers that should only be callable from server code (stored under the `internal.` prefix).

### 2. Consume from React

```tsx
"use client"
import { useQuery, useMutation } from "@/hooks/useQuery" // or wherever install placed them

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

`useQuery` opens a WebSocket to `/ws`, runs the query, and re-runs it whenever a watched collection changes. `useMutation` POSTs to `/api/handlers`.

### 3. Run it

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

## CLI

- `mogobase install` — scaffold files into the consuming project. Re-run to update; answer `oa` to overwrite all on conflict.
- `mogobase dev` — standalone dev server (Hono-based), used when you don't want to run Next.js. Loads handlers from `./mogobase/*.ts`.

## License

MIT
