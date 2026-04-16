# Mogobase Setup (Next.js App Router)

Complete flow for adding mogobase to a Next.js project.

## Prerequisites

- Next.js 14+ (App Router).
- Node 20+.
- A reachable MongoDB instance (local or remote).

## Step 1 — Install packages

```bash
yarn add mogobase ws
yarn add -D @types/ws
```

If you plan to use the **WatermelonDB** offline backend, also:

```bash
yarn add @nozbe/watermelondb
```

Otherwise the default RxDB backend works out of the box (it's a normal dependency of `mogobase`).

## Step 2 — Scaffold files

```bash
npx mogobase install
```

This writes:

- `src/hooks/useQuery.ts`, `useMutation.ts`, `usePaginatedQuery.ts`, `index.ts` (or `hooks/` if no `src/` folder).
- `src/app/api/handlers/route.ts` (or `app/api/handlers/route.ts`).
- `server.ts` at the project root.
- Creates `./mogobase/` for your handler files.

All four are templates — it's fine to edit the hook sources after install.

If the consumer already has files in those locations, `install` overwrites them. Always read the diff after `npx mogobase install` and revert any unintended changes.

## Step 3 — Update package.json scripts

```json
{
  "scripts": {
    "dev": "tsx server.ts",
    "build": "next build",
    "start": "NODE_ENV=production tsx server.ts"
  }
}
```

The custom `server.ts` replaces Next's default dev server so it can attach the WebSocket upgrade handler at `/ws`.

## Step 4 — Environment

Create `.env.local`:

```
MONGO_URI=mongodb://localhost:27017
MONGO_DB=my_app_db
```

Defaults (if unset): `MONGO_URI=mongodb://localhost:27017`, `MONGO_DB=mogobase`. Always set an explicit `MONGO_DB` per app.

For split-origin or SSR deploys, also set `NEXT_MOGOBASE_URL` (or `MOGOBASE_URL` in server code) pointing at the HTTP/WS origin.

## Step 5 — Wrap your app with MogobaseProvider

In the root layout (or a client component mounted there):

```tsx
"use client"
import MogobaseProvider from "mogobase/provider"

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MogobaseProvider
      online={true}
      handlers={() => import("@/mogobase")}
      offlineAdapter="rxdb"
    >
      {children}
    </MogobaseProvider>
  )
}
```

Then mount `<Providers>` inside `app/layout.tsx`. When `online={false}`, the provider lazy-loads the offline store and replays handler registrations into it.

If the project only needs online mode, you can skip `handlers` and `offlineAdapter`.

## Step 6 — Add handlers

Create `./mogobase/todos.ts`:

```ts
import { query, mutation, v, defineModel } from "mogobase/runtime"

defineModel("todos")

query("listTodos", {
  args: v.object({}),
  handler: async (_args, { db }) => {
    return db.model("todos").find({}).toArray()
  },
})

mutation("createTodo", {
  args: v.object({ title: v.string() }),
  handler: async ({ title }, { db }) => {
    const now = Date.now()
    const result = await db.model("todos").insertOne({ title, done: false, createdAt: now })
    return result.insertedId
  },
})
```

Every file in `./mogobase/` is imported by `server.ts` at boot (and by the offline `handlers={() => import("@/mogobase")}` loader). Handler registration happens at module scope via `query()` / `mutation()`.

## Step 7 — Run

```bash
yarn dev
```

Check the console for `[mogobase] attached WebSocket at /ws` and visit `http://localhost:3000`.

## Sanity check

- `server.ts` exists at project root.
- `app/api/handlers/route.ts` (or `src/app/api/handlers/route.ts`) exists.
- `./mogobase/` exists with at least one handler file.
- `./mogobase/` handler files all `import { ... } from "mogobase/runtime"` (NOT `mogobase/server`).
- The app is wrapped in `<MogobaseProvider>` somewhere in the component tree.
- `MONGO_URI` and `MONGO_DB` are set in `.env.local`.
- `package.json` scripts use `tsx server.ts` (not `next dev`).

Use the `mogobase_check_setup` tool to verify all of this automatically.
