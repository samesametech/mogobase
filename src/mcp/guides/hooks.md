# React Hooks: useQuery, useMutation, usePaginatedQuery

Hooks are copied into your project via `mogobase install` (to `@/hooks` or `./hooks`). They're templates — feel free to edit. Re-exported as a barrel `@/hooks/index.ts` so:

```ts
import { useQuery, useMutation, usePaginatedQuery } from "@/hooks"
```

## useQuery

```tsx
"use client"
import { useQuery } from "@/hooks"

export function TodoList() {
  const { data, loading, error } = useQuery("listTodos", {})
  if (loading) return <p>Loading…</p>
  if (error) return <p>Error: {error.message}</p>
  return <ul>{data?.map(t => <li key={t._id}>{t.title}</li>)}</ul>
}
```

**Online mode**: opens a native WebSocket to `/ws` on `window.location.origin`, sends `{ type: "query", name: "listTodos", args: {} }`, receives a `QueryResult`, and re-runs the handler on every matching change-stream event. Each re-run replaces `data` wholesale. For cursor-paginated results, use `usePaginatedQuery` instead.

**Offline mode**: runs the handler directly against `clientDB` and re-runs on `clientDB.observeChanges(collectionName)` events.

Args are deep-compared between renders — changing `args` re-subscribes.

## useMutation

```tsx
"use client"
import { useMutation } from "@/hooks"
import { useState } from "react"

export function CreateTodo() {
  const [title, setTitle] = useState("")
  const { mutate, loading } = useMutation("createTodo")
  return (
    <form onSubmit={async (e) => {
      e.preventDefault()
      await mutate({ title })
      setTitle("")
    }}>
      <input value={title} onChange={e => setTitle(e.target.value)} />
      <button disabled={loading}>Add</button>
    </form>
  )
}
```

**Online mode**: POSTs to `/api/handlers`.
**Offline mode**: runs the mutation against `clientDB`.

## usePaginatedQuery

For cursor-paginated queries (handler uses `PaginationQueryArgs`):

```tsx
"use client"
import { usePaginatedQuery } from "@/hooks"

export function Feed() {
  const { results, loadNext, hasNext, loadPrevious, hasPrevious, isLoading } =
    usePaginatedQuery(
      "listPosts",
      { authorId },
      { pageSize: 20, sortAscending: false, paginatedField: "_id" }
    )
  return (
    <>
      {results.map(p => <article key={p._id}>{p.title}</article>)}
      {hasNext && <button onClick={loadNext} disabled={isLoading}>Load more</button>}
    </>
  )
}
```

### Protocol (online)

When any `ctx.watch(...)`-registered collection emits a change-stream event, the server re-runs the handler with the currently loaded window as the effective `limit` and pushes a fresh `PaginatedQueryResult`. The client replaces `results` wholesale. This matches `useQuery`'s semantics — pagination just scopes the result set.

Client → server:

| Frame | When |
|---|---|
| `{ type: "paginated-query", name, args: { ...args, paginationOpts } }` | First mount or when `args` / `pageSize` change. |
| `{ type: "paginated-query-load-next" }` | `loadNext()` — appends the next page using the stored next cursor. |
| `{ type: "paginated-query-load-previous" }` | `loadPrevious()` — prepends the previous page. |

Server → client:

| Frame | Contains |
|---|---|
| `PaginatedQueryResult` | `data` with `{ results, hasNext, hasPrevious, next, previous }`. Emitted on initial subscribe **and** on every subsequent watched change. Replaces the whole displayed result set. |
| `PaginatedQueryPage` | `{ direction: "next" \| "previous", data: { results, hasNext \| hasPrevious } }` — result of a subsequent load. |

The server tracks `loadedCount` per subscription and uses it as `paginationOpts.limit` on refetches, so scrolled-through pages stay visible even after a live refresh. Concurrent `loadNext`/`loadPrevious` and live refetches are serialized on a per-subscription promise chain, so client frames never arrive out of order.

### TanStack Virtual compatibility

`isLoading` only flips `true` on user-initiated ops (initial subscribe, `loadNext`, `loadPrevious`) — background live refetches leave it `false`. This preserves the canonical infinite-scroll guard:

```tsx
const parentRef = useRef<HTMLDivElement>(null)
const virtualizer = useVirtualizer({
  count: results.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 120,
  getItemKey: (i) => results[i]?._id ?? i,
})

const virtualItems = virtualizer.getVirtualItems()
const lastItem = virtualItems[virtualItems.length - 1]

useEffect(() => {
  if (!lastItem) return
  if (lastItem.index >= results.length - 1 && hasNext && !isLoading) {
    loadNext()
  }
}, [lastItem, results.length, hasNext, isLoading, loadNext])
```

Pass `getItemKey: (i) => results[i]?._id` to keep virtualizer row positions stable across refetches. The server returns results in the same sort order (as defined by the handler's `MongoPaging.find` call) on every refetch.

### Protocol (offline)

In offline mode the hook runs the handler directly against `clientDB`, uses returned cursors for `loadNext` / `loadPrevious`, and re-runs the page fetch whenever any watched collection fires `observeChanges`. Unlike the online path, offline refetches are always scoped to the initial `pageSize` — the loaded window is not preserved offline, so scrolled-through pages collapse back to a single page on any watched change. Preserving scroll position is the consumer's job.

## URL resolution

Hooks derive the WS/HTTP origin from `window.location` by default. Override via env:

- `NEXT_PUBLIC_MOGOBASE_URL` — client-visible override (exposed to browser bundle).
- `MOGOBASE_URL` — server-side override for SSR.

Useful when the mogobase server runs on a different origin than the Next.js app.

## Hooks are templates

The files copied by `mogobase install` are intentionally normal TS files — not compiled library code. You can edit them to:

- Add auth headers to the fetch + WebSocket handshake.
- Swap the WebSocket transport for server-sent events.
- Add toast notifications on mutation errors.
- Use a different loading state shape.

Do NOT edit `@/hooks` to change handler semantics — the custom behavior lives in your handler code, not the transport layer.

## Provider requirement

All three hooks rely on `useMogobase()` to get `online` / `clientDB`. They throw if the consumer hasn't wrapped the app in `<MogobaseProvider>`. See `provider` guide.
