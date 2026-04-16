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

**Online mode**: opens a native WebSocket to `/ws` on `window.location.origin`, sends `{ type: "query", name: "listTodos", args: {} }`, receives `QueryResult` and subsequent `UpdateDoc` frames. The hook updates `data` on each frame.

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
  const { data, loadMore, hasMore, loading } = usePaginatedQuery("listPosts", {
    limit: 20,
    sortAscending: false,
  })
  return (
    <>
      {data?.map(p => <article key={p._id}>{p.title}</article>)}
      {hasMore && <button onClick={loadMore} disabled={loading}>Load more</button>}
    </>
  )
}
```

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
