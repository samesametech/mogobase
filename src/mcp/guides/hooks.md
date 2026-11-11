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

When any `ctx.watch(...)`-registered collection emits a change-stream event, the server re-reads the currently loaded window — **up to `maxRerunRows` rows (default 1000, never below the first page)** — and pushes a fresh `PaginatedQueryResult`. It reads the window in pages of at most 300 rows (mongo-cursor-pagination's `MAX_LIMIT`), walking the `next` cursor, so a list scrolled past 300 rows keeps every row; your handler runs once per page. The client replaces `results` wholesale. This matches `useQuery`'s semantics — pagination just scopes the result set. **Cost:** a re-run is one handler call per 300 re-read rows, run one after another (each page needs the previous page's cursor), and ships every re-read row. **Past the cap** (`attachMogobaseWebSocket(server, "/ws", { maxRerunRows })`): the re-run answers with the first `maxRerunRows` rows and `hasNext: true`, so a client scrolled to 3,000 rows sees its list shrink to 1,000 on the next change — a scroll jump if it was looking past row 1,000 — and `loadNext` continues from row 1,000. A window that grew **upward** past the cap (`loadPrevious` over 1,000 rows above where it started) keeps the 1,000 rows nearest where it started, with `hasPrevious: true`, and `loadPrevious` continues from there: finding its first rows would mean reading every row above them, which is the cost the cap exists to bound. That bounds a change's cost at ceil(1000 / 300) = 4 handler calls and 1,000 rows whatever a client loaded; without it the loaded window, which a client grows at will with `loadNext`, set the cost of every write. `maxRerunRows: Infinity` restores the uncapped re-read. For long lists, a virtualized view that keeps its scroll anchor by row id handles the shrink best. Keep busy collections' lists short, use `ignoreFields` to skip writes the list does not show, or narrow the watch.

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

The server tracks `loadedCount` per subscription and re-reads that many rows on refetches (up to `maxRerunRows`), so scrolled-through pages stay visible after a live refresh as long as the window is within the cap. Concurrent `loadNext`/`loadPrevious` and live refetches are serialized on a per-subscription promise chain, so client frames never arrive out of order.

**Request ids (`rid`).** Any request frame above (and `{ type: "query" }`) may carry `rid` — a string of at most 200 characters, or a number. The server echoes it on the answers: the request's own answer, and every re-run after it, carry the rid that was current when that run **started**; a load message's `rid` becomes the subscription's current one. So after a write, a client that re-asks with a new `rid` can tell the answer it asked for (new `rid`, read after the request arrived) from one already in flight (older `rid`, possibly read before the write), and clear a "stale" mark only on the former. A client that sends no `rid` gets frames without one. The bundled hooks do not send one.

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
