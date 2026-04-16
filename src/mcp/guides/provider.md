# MogobaseProvider

The provider supplies the runtime mode flag and (in offline mode) the client DB to every hook.

## Import

```ts
import MogobaseProvider, { useMogobase } from "mogobase/provider"
```

## Props

| Prop | Type | Purpose |
|---|---|---|
| `online` | `boolean` (required) | When `true`, hooks use HTTP + WebSocket. When `false`, hooks run handlers against a local store. |
| `handlers` | `() => Promise<unknown>` | Async loader that triggers handler registration. Typically `() => import("@/mogobase")`. Required for offline mode; optional for online (the server already loaded handlers). |
| `dbName` | `string` | Custom DB name for the offline store. Defaults to backend-specific default. |
| `offlineAdapter` | `"rxdb" \| "watermelon"` | Which offline backend to use. Default `"rxdb"`. |

## Minimal online-only setup

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

## Online + offline (network-aware)

```tsx
"use client"
import MogobaseProvider from "mogobase/provider"
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
      handlers={() => import("@/mogobase")}
      offlineAdapter="rxdb"
    >
      {children}
    </MogobaseProvider>
  )
}
```

## Boot sequence

When `online={false}` the provider:

1. Lazy-imports the chosen backend (`./db` for RxDB, `./db/watermelon` for WatermelonDB).
2. Calls `ClientDB.connect(dbName)`.
3. Calls your `handlers()` loader (which imports `./mogobase/*.ts` and registers all handlers via `mogobase/runtime`).
4. Replays the model registry (`getModels()` from `mogobase/runtime`) into `ClientDB.defineModel(...)`.
5. Sets `ready: true` and exposes the DB via `useMogobase().clientDB`.

Online mode is instant — `ready: true` immediately; no offline lazy-loading happens.

## Toggle at runtime

Changing the `online` prop re-runs the boot effect. Going online → offline remounts the offline-store subscriptions; going offline → online closes them. Hook consumers don't need to handle this themselves.

## Gotchas

- **Must be a client component** — the file has `"use client"` at the top. React context doesn't cross the RSC boundary.
- **Handlers loader must be stable** — changing the `handlers` prop on every render will re-trigger boot. Define it at module scope or inline (inline is fine since `() => import("@/mogobase")` is a new function but the `import()` is cached).
- **SSR-safety**: `useMogobase()` throws if no provider is found. Don't call hooks in server components — wrap in client components only.
