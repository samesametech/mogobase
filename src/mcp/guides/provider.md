# MogobaseProvider

The provider supplies the runtime mode flag and (in offline mode) the client DB to every hook.

## Import

```ts
import MogobaseProvider, { useMogobase } from "mogobase/provider"
```

## Props

| Prop | Type | Purpose |
|---|---|---|
| `online` | `boolean` (required) | When `true`, hooks use HTTP + WebSocket. When `false`, hooks run handlers against `clientDB`. |
| `handlers` | `() => Promise<unknown>` | Async loader that triggers handler registration. Typically `() => import("@/mogobase")`. Required for offline mode; optional for online (the server already loaded handlers). |
| `dbName` | `string` | Custom DB name for the offline store. Defaults to backend-specific default. |
| `clientDB` | `MogobaseClientDB` | **Required when `online={false}`.** The offline-store singleton — import from `mogobase/client-db` (RxDB) or `mogobase/client-db/watermelon` (WatermelonDB) and pass the default export. The provider holds zero references to either backend module, so consumers that never pass `clientDB` ship neither package's code. |

## Online-only setup

No offline backend, no extra installs. `rxdb` and `@nozbe/watermelondb` stay out of `node_modules`.

```tsx
// app/providers.tsx
"use client"
import MogobaseProvider from "mogobase/provider"

export default function Providers({ children }: { children: React.ReactNode }) {
  return <MogobaseProvider online={true}>{children}</MogobaseProvider>
}
```

```tsx
// app/layout.tsx
import Providers from "./providers"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><Providers>{children}</Providers></body>
    </html>
  )
}
```

## Online + offline (RxDB, default backend)

```tsx
"use client"
import MogobaseProvider from "mogobase/provider"
import RxClientDB from "mogobase/client-db"
import { useEffect, useState } from "react"

export default function Providers({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine
  )
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener("online", up)
    window.addEventListener("offline", down)
    return () => {
      window.removeEventListener("online", up)
      window.removeEventListener("offline", down)
    }
  }, [])

  return (
    <MogobaseProvider
      online={online}
      clientDB={RxClientDB}
      handlers={() => import("@/mogobase")}
    >
      {children}
    </MogobaseProvider>
  )
}
```

Install: `yarn add rxdb`.

## Online + offline (WatermelonDB)

```tsx
"use client"
import MogobaseProvider from "mogobase/provider"
import WatermelonClientDB from "mogobase/client-db/watermelon"

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MogobaseProvider
      online={true /* or a network-aware boolean */}
      clientDB={WatermelonClientDB}
      handlers={() => import("@/mogobase")}
    >
      {children}
    </MogobaseProvider>
  )
}
```

Install: `yarn add @nozbe/watermelondb`.

## Boot sequence

When `online={false}` the provider:

1. Throws if `clientDB` is missing — message points at `mogobase/client-db` and `mogobase/client-db/watermelon`.
2. Calls `clientDB.connect(dbName)`.
3. Calls your `handlers()` loader (which imports `./mogobase/*.ts` and registers all handlers via `mogobase/runtime`).
4. Replays the model registry (`getModels()` from `mogobase/runtime`) into `clientDB.defineModel(...)`.
5. Sets `ready: true` and exposes `clientDB` via `useMogobase().clientDB`.

Online mode is instant — `ready: true` immediately; the provider never touches an offline backend.

## Toggle at runtime

Changing the `online` prop re-runs the boot effect. Going online → offline remounts the offline-store subscriptions; going offline → online closes them. Hook consumers don't need to handle this themselves. Pass the same `clientDB` reference across renders so React's dep array doesn't churn.

## Why caller-injected `clientDB`?

Bundlers (Webpack, Turbopack, Vite) treat literal-string dynamic-import targets as known chunks and walk into them at build time. If the provider tried to choose a backend at runtime — e.g. `await import("./db/watermelon")` — the bundler would still resolve `@nozbe/watermelondb` during the build, forcing every consumer to install it. By moving the import into the consumer's own code, only the backend you actually pass is in the bundle, and only its peer package is in your `package.json`.

## Gotchas

- **Must be a client component** — the file has `"use client"` at the top. React context doesn't cross the RSC boundary.
- **Handlers loader must be stable** — changing the `handlers` prop on every render will re-trigger boot. Define it at module scope or inline (inline is fine since `() => import("@/mogobase")` is a new function but the `import()` is cached).
- **Stable `clientDB` reference** — pass the imported singleton directly. Don't wrap it in `useMemo` per-render or construct a new object each render; the dep array would invalidate every commit.
- **SSR-safety**: `useMogobase()` throws if no provider is found. Don't call hooks in server components — wrap in client components only.
- **Missing `clientDB` when offline** — throws `[mogobase] <MogobaseProvider online={false}> requires a 'clientDB' prop. …` with a fix-it hint.
