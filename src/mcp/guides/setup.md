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

For online-only apps, that's it — `rxdb` and `@nozbe/watermelondb` are both **optional peer dependencies**. Skip them entirely if you don't need offline mode.

If you plan to use offline mode, install one backend:

```bash
# RxDB backend (Dexie/IndexedDB) — default choice
yarn add rxdb

# OR WatermelonDB backend (LokiJS) — pick this for React Native or large local datasets
yarn add @nozbe/watermelondb
```

Whichever you install, the consumer code imports its singleton from the matching subpath (`mogobase/client-db` or `mogobase/client-db/watermelon`) and passes it to the provider — see Step 5.

## Step 2 — Scaffold files

```bash
npx mogobase install
```

This writes:

- `src/hooks/useQuery.ts`, `useMutation.ts`, `usePaginatedQuery.ts`, `index.ts` (or `hooks/` if no `src/` folder).
- `src/app/api/handlers/route.ts` (or `app/api/handlers/route.ts`).
- `src/app/api/sync/route.ts` (or `app/api/sync/route.ts`) — HTTP fallback for sync mode. Harmless if you don't use sync; required if you do. Replace its placeholder `getSession` and `syncPolicy` with your real auth integration before enabling sync.
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

In the root layout (or a client component mounted there).

**Online-only** — no offline backend installed:

```tsx
"use client"
import MogobaseProvider from "mogobase/provider"

export default function Providers({ children }: { children: React.ReactNode }) {
  return <MogobaseProvider online={true}>{children}</MogobaseProvider>
}
```

**With offline mode** — import a backend singleton and pass it as `clientDB`:

```tsx
"use client"
import MogobaseProvider from "mogobase/provider"
import RxClientDB from "mogobase/client-db" // or "mogobase/client-db/watermelon"

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MogobaseProvider
      online={true /* or a network-aware boolean */}
      clientDB={RxClientDB}
      handlers={() => import("@/mogobase")}
    >
      {children}
    </MogobaseProvider>
  )
}
```

Then mount `<Providers>` inside `app/layout.tsx`. When `online={false}`, the provider connects `clientDB`, runs `handlers()` so handler registrations land in the runtime singleton, and replays `defineModel` calls against the local store.

For online-only apps, skip the offline backend install, the `clientDB` prop, and `handlers` — the WebSocket path serves all queries and mutations.

## Step 5b (sync only) — Wire a SyncPolicy

When `sync={true}`, every pull/push/watch goes through a `SyncPolicy` callback
that decides allow/filter/transform per-op. **Default-deny**: a model
without `sync: true` on `defineModel` throws; a request without an
`allow: true` decision is rejected.

Define the policy once and wire it into both transports:

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

WebSocket transport (in `server.ts`):

```ts
import { attachMogobaseWebSocket } from "mogobase/server"
import { syncPolicy } from "./mogobase/syncPolicy"

attachMogobaseWebSocket(server, "/ws", { syncPolicy })
```

HTTP fallback (in `src/app/api/sync/route.ts`): replace the scaffolded
placeholder policy with an import of the same module:

```ts
import { syncPolicy } from "../../../../mogobase/syncPolicy"
```

See `mogobase://guide/sync` for the full security model (default-deny
allowlist, `clientFields` projection, server-owned timestamps, push batch
cap).

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
