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

**Online mode**: opens a native WebSocket to `/ws` on `window.location.origin`, sends `{ type: "query", name: "listTodos", args: {} }`, receives a `QueryResult`, and re-runs the handler on every matching change-stream event. Each re-run replaces `data` wholesale. For incremental diffs over a cursor window, use `usePaginatedQuery` instead.

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

Unlike `useQuery` (which re-runs the whole handler on every change), `usePaginatedQuery` maintains a **window-scoped live subscription** over the loaded pages and applies incremental diffs.

Client → server:

| Frame | When |
|---|---|
| `{ type: "paginated-query", name, args: { ...args, paginationArgs } }` | First mount or when `args` / `pageSize` change. |
| `{ type: "paginated-query-load-next" }` | `loadNext()` — appends the next page using the stored next cursor. |
| `{ type: "paginated-query-load-previous" }` | `loadPrevious()` — prepends the previous page. |

Server → client:

| Frame | Contains |
|---|---|
| `PaginatedQueryResult` | `data` with `{ results, hasNext, hasPrevious, next, previous }` — result of the initial handler run. |
| `PaginatedQueryPage` | `{ direction: "next" \| "previous", data: { results, hasNext \| hasPrevious } }` — result of a subsequent load. |
| `AddDoc` | A doc entered the loaded window (insert, or update that moved it into window/matcher). Client inserts sorted by `paginatedField`. |
| `UpdateDoc` | A doc in the loaded window changed but stayed in the window. Client merges by `_id`. |
| `RemoveDoc` | A doc left the loaded window (delete, update that moved it out, or matcher mismatch). Client drops by `_id`. |

The server tracks each subscription's loaded id window as `[min, max]` along with `lowerOpen`/`upperOpen` derived from `hasPrevious` × `sortAscending`. Change-stream events (`insert` / `update` / `replace` / `delete`) are filtered against the handler's `filter` passed to `ctx.watch(...)` and then tested against the window. A single change stream persists across `loadNext` / `loadPrevious` — the window grows but the subscription doesn't reset.

### Protocol (offline)

In offline mode the hook runs the handler directly against `clientDB`, uses returned cursors for `loadNext` / `loadPrevious`, and re-runs the full page fetch whenever any watched collection fires `observeChanges`. There are no per-doc `AddDoc` / `UpdateDoc` / `RemoveDoc` diffs offline — changes always trigger a full first-page refetch (preserving the current scroll position is the consumer's job).

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
