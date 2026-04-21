# Paginated query: refetch-and-replace on any watched change

## Problem

`usePaginatedQuery` currently maintains a **window-scoped incremental live
subscription** on the server (`attachWs.ts`):

- The handler is run **once** at subscribe time. The returned page results,
  filter, `paginatedField`, and `hasPrevious`/`hasNext` are stored on a
  `PaginatedSub`.
- The server opens **one** change stream (`if (sub.changeStream) return` —
  additional `ctx.watch` calls are silently dropped).
- Change-stream events are evaluated locally via `matchFilter` +
  `keyInWindow` and the server emits incremental `AddDoc` / `UpdateDoc` /
  `RemoveDoc` frames. The handler is **not** re-run.

This breaks two real cases that show up in `mogobase-examples`:

1. **Joined / enriched queries.** `posts.all` returns posts enriched with
   `category` (via a second collection lookup). The UI renders
   `post.category?.name`. When a category's name changes, neither problem
   (a) nor (b) emits a useful update:

   - (a) Only the first `ctx.watch(...)` is honored, so watching `categories`
     alongside `posts` is dropped.
   - (b) Even if the change stream covered `categories`, the incremental
     path emits the changed category doc — not the re-enriched post docs.
     The UI shows stale category names until the user re-mounts the query.

2. **Inconsistency with other paths.** Both `useQuery` (online) and the
   offline paginated path already behave as "run the handler, on any
   watched change re-run and replace." The paginated online path is the
   outlier.

## Goal

When any `ctx.watch(...)`-registered collection fires a change stream event,
the server re-runs the handler with the **currently loaded window** as the
effective `limit` and replaces the client's data with the fresh result.

## Non-goals

- No new consumer-facing API (hook signature unchanged from
  `{ results, hasNext, loadNext, hasPrevious, loadPrevious, isLoading }`).
- No debouncing of burst events. Mutations are typically user-scale; bulk
  churn is rare. Can be added later if measured to matter.
- No opt-in "incremental" mode. One code path.
- No server-side virtualization or on-demand partial updates. The wire
  cost of a full-window refetch is a known tradeoff.

## Design

### Server — `src/server/attachWs.ts`

**`PaginatedSub` shrinks.** New shape:

```ts
type PaginatedSub = {
  name: string
  baseArgs: any
  headers: IncomingMessage["headers"]
  limit: number
  sortAscending: boolean
  sortCaseInsensitive: boolean
  loadedCount: number           // replaces `ids` Map
  hasPrevious: boolean
  hasNext: boolean
  nextCursor?: string
  previousCursor?: string
  changeStreams: ChangeStream[] // plural
  // Serialization queue for concurrent ops on this sub:
  queue: Promise<void>
}
```

Dropped fields: `filter`, `paginatedField`, `ids`, `changeStream` (singular).

**`ctx.watch` inside the paginated handler** opens a **new** change stream
on every call but **defers** attaching the `on("change", ...)` listener
until after the initial handler run has completed and the sub is installed
in `state`:

```ts
// During initial run:
const pendingStreams: ChangeStream[] = []
watch: (modelName, pipelineOrFilter) => {
  const pipeline = Array.isArray(pipelineOrFilter) ? pipelineOrFilter : undefined
  const cs = DB.model(modelName).watch(pipeline, {
    fullDocument: "updateLookup",
  } as ChangeStreamOptions)
  pendingStreams.push(cs)
}

// After _runQuery returns and sub is stored in state:
sub.changeStreams = pendingStreams
for (const cs of pendingStreams) {
  cs.on("change", () => scheduleRefetch(id, ws, sub))
}
```

This avoids a race where a mid-initial-run change event would call
`scheduleRefetch` before `sub` is registered in `state`. MongoDB change
streams buffer events before a listener is attached, so events emitted
during the initial run are still delivered once listeners are wired — we
only delay the handler-triggered refetch, not lose events.

No `fullDocumentBeforeChange` needed anymore — we never look at pre-images.
Plain object filters (second arg) are **ignored** by the paginated path;
they were only used by `matchFilter` which is going away. Options argument
is ignored too (`paginatedField`, `sortAscending` are read from
`paginationOpts` in the args, not from watch options). Leaving the
`ctx.watch` **signature** unchanged preserves compatibility with existing
handlers.

**`scheduleRefetch(id, ws, sub)`** appends to `sub.queue` so all paginated
ops (initial, loadNext/loadPrevious, refetch) serialize on a single
promise chain. This prevents an out-of-order `PaginatedQueryResult` from
clobbering a concurrent `PaginatedQueryPage`:

```ts
function scheduleRefetch(id, ws, sub) {
  sub.queue = sub.queue.then(() => runRefetch(id, ws, sub)).catch(() => {})
}
```

**`runRefetch(id, ws, sub)`:**

```ts
async function runRefetch(id, ws, sub) {
  // Bail if socket closed or sub was replaced (args changed).
  const s = state.get(id)
  if (!s || s.paginated !== sub || ws.readyState !== ws.OPEN) return

  const paginationOpts = {
    limit: sub.loadedCount,
    sortAscending: sub.sortAscending,
    sortCaseInsensitive: sub.sortCaseInsensitive,
  }
  const callArgs = { ...sub.baseArgs, paginationOpts }

  try {
    await DB.connect()
    const rs = await handlers._runQuery(sub.name, callArgs, {
      headers: sub.headers,
      db: DB,
      watch: () => {}, // no-op: streams already open from initial run
    })
    if (!rs?.results) throw new Error("Invalid paginated result")

    sub.loadedCount = rs.results.length
    sub.hasPrevious = !!rs.hasPrevious
    sub.hasNext = !!rs.hasNext
    sub.nextCursor = rs.hasNext ? rs.next : undefined
    sub.previousCursor = rs.hasPrevious ? rs.previous : undefined

    sendJson(ws, { type: "PaginatedQueryResult", success: true, data: rs })
  } catch (error: any) {
    sendJson(ws, {
      type: "PaginatedQueryResult",
      success: false,
      error: `${error?.message || error}`,
    })
  }
}
```

Note the reuse of `PaginatedQueryResult` — no new frame type. The client's
existing handler already does `setData(results)` on receipt.

**`runPaginatedInitial`** is unchanged in structure, but:

- Stores `headers` on the sub (for use by refetches).
- Collects multiple change streams instead of one.
- Initializes `loadedCount = rs.results.length` instead of building an
  `ids` Map.
- Installs each change stream's `on("change", ...)` to call
  `scheduleRefetch`.
- Replaces any prior sub by closing its streams first (`closePaginatedSub`
  becomes "close all streams in the plural array").

**`runPaginatedLoadMore`** is unchanged in behavior but now runs through
`sub.queue` for serialization, and updates `sub.loadedCount += results.length`
(instead of growing `ids`).

**Deletions:**

- `src/server/matchFilter.ts` — only used by the incremental path. Delete.
- Helper functions `keyStr`, `cmp`, `windowExtremes`, `boundOpenness`,
  `keyInWindow`, `handleChange` — all dead. Delete.

### Client — `src/client/hooks/usePaginatedQuery.ts`

**Message handlers:**

- `PaginatedQueryResult` — unchanged. Now fires both on initial and on every
  live refetch. Already does `setData(results || [])` and updates
  `hasNext` / `hasPrevious`.
- `PaginatedQueryPage` — unchanged.
- `AddDoc`, `UpdateDoc`, `RemoveDoc` — **removed**. Paginated path no longer
  emits these. (`useQuery` never emitted them.)

**Loading state — unchanged semantics:**

- `setLoading(true)` happens on: initial subscribe, `loadNext` send,
  `loadPrevious` send.
- `setLoading(false)` happens on: any `PaginatedQueryResult` /
  `PaginatedQueryPage` receipt.
- We never call `setLoading(true)` from a server-pushed frame. Live
  refetches arrive as `PaginatedQueryResult` and only ever flip
  `loading` from false → false (no-op) when no pagination is in flight.
- During a concurrent `loadNext` + live refetch, the server's FIFO queue
  guarantees ordered frames; `loading` drops to false on whichever arrives
  first and stays false on the second. Consumers who need an explicit
  "background refreshing" indicator can observe `results` reference
  changes themselves.

**Helper cleanup:**

- Remove `insertSorted` (only used by the `AddDoc` handler).
- Keep `mergeArray` (still used by `PaginatedQueryPage`).
- `paginatedField` / `sortAscending` in closure scope — `sortAscending` is
  still used for the pagination args payload; `paginatedField` is no longer
  consumed client-side (the server reads it from `args.paginationOpts`
  per handler). Can stop reading `paginatedField` in the hook body if it
  becomes unused.

### Protocol

**Client → server (unchanged):**

| Frame | When |
|---|---|
| `{ type: "paginated-query", name, args }` | Initial subscribe / args change |
| `{ type: "paginated-query-load-next" }` | `loadNext()` |
| `{ type: "paginated-query-load-previous" }` | `loadPrevious()` |

**Server → client:**

| Frame | Contains | Change |
|---|---|---|
| `PaginatedQueryResult` | `{ results, hasNext, hasPrevious, next, previous }` | **Now also emitted on any watched change.** Previously only emitted on initial subscribe. |
| `PaginatedQueryPage` | `{ direction, data: { results, hasNext \| hasPrevious } }` | Unchanged |
| ~~`AddDoc`~~ | — | **Removed from paginated path.** |
| ~~`UpdateDoc`~~ | — | **Removed from paginated path.** |
| ~~`RemoveDoc`~~ | — | **Removed from paginated path.** |

Consumers whose installed hook files still reference `AddDoc` / `UpdateDoc` /
`RemoveDoc` handlers will see them become dead code — no error, just
unreachable branches. Re-running `mogobase install` gets the new shape.

### Virtualization compatibility (TanStack Virtual)

The hook surface already satisfies the canonical TanStack Virtual +
infinite-scroll pattern:

| TanStack needs | Our hook |
|---|---|
| `allRows` (stable-keyed array) | `results`, each with Mongo `_id` |
| `hasNextPage` | `hasNext` |
| `fetchNextPage()` | `loadNext()` |
| `isFetchingNextPage` guard | `isLoading` |

The **one compatibility requirement** this design preserves: `isLoading`
must not flip to `true` on a background live refetch. If it did, the
virtualizer's "scroll past end ⇒ fetch next page" effect would
incorrectly skip triggering `loadNext` during a background update, since
its common pattern is:

```ts
if (lastItem.index >= results.length - 1 && hasNext && !isLoading) {
  loadNext()
}
```

Our design only sets `isLoading = true` on user-initiated ops (init,
`loadNext`, `loadPrevious`). Live refetches arrive as server-pushed
`PaginatedQueryResult` and only ever `setLoading(false)`, so the
guard stays correct.

Consumers pass `getItemKey: (i) => results[i]?._id` to keep virtualizer
positions stable across refetches. The server returns results in the
same `paginatedField` sort order every time, so visible rows don't jump.

### Files touched

**Edit:**

- `src/server/attachWs.ts` — core rewrite of the paginated path (see
  above). **Also rename the args key** `paginationArgs` → `paginationOpts`
  (two sites: `runPaginatedInitial`'s `args?.paginationArgs` and the
  `delete baseArgs.paginationArgs` plus `runPaginatedLoadMore`'s
  `{ ...sub.baseArgs, paginationArgs }` → `paginationOpts`). This aligns
  the server with the hook, which already sends `paginationOpts`.
  Consumer handler files that destructure `args.paginationArgs` need to
  update to `args.paginationOpts`.
- `src/server/ws.ts` — legacy Hono WS wiring. Same
  `paginationArgs` → `paginationOpts` rename (two sites mirroring
  `attachWs.ts`). Keep in sync even though `ws.ts` isn't used from the
  Next.js custom-server path.
- `src/client/hooks/usePaginatedQuery.ts` — remove incremental handlers,
  remove `insertSorted`. The source already uses `paginationOpts` as the
  payload key (no hook-source rename needed).
- `README.md` — rewrite the paginated reactive bullet (`Reactive queries`
  line), remove mention of `AddDoc` / `UpdateDoc` / `RemoveDoc` diffs,
  remove the "paginatedField / sortAscending window" language from the
  `ctx.watch` bullet.
- `src/mcp/guides/hooks.md` — rewrite the "Protocol (online)" section
  under `usePaginatedQuery` to describe refetch-and-replace semantics and
  drop the `AddDoc`/`UpdateDoc`/`RemoveDoc` table rows. Note the
  TanStack Virtual compatibility guarantee. Update the client → server
  frame row from `{ ...args, paginationArgs }` to
  `{ ...args, paginationOpts }`.
- `src/mcp/guides/handlers.md` — rewrite the `ctx.watch` second-arg and
  options sections to reflect that paginated handlers now behave like
  `useQuery` (filter / paginatedField / sortAscending arguments are
  no longer needed for paginated, but are still accepted for signature
  compatibility with `useQuery` pipeline forwarding). Update the
  `listPosts` example to drop the filter-as-matcher language and to
  use `paginationOpts` instead of `paginationArgs` in both the args
  schema (`paginationOpts: PaginationQueryArgs`) and the handler body
  (`args.paginationOpts.limit`, etc.).
- `src/mcp/guides/troubleshooting.md` — update the entry that mentions
  `args.paginationArgs` to `args.paginationOpts`, and remove the
  filter-as-matcher guidance (no longer needed with refetch-and-replace).
- `CLAUDE.md` — rewrite the `attachWs.ts` architecture paragraph to
  describe the new refetch semantics, remove the
  `matchFilter` / `keyInWindow` / `PaginatedSub.ids` description, and
  update any `paginationArgs` references to `paginationOpts`.
- `package.json` — version bump to `2.5.0` (already uncommitted at
  head of `main`; this spec formalizes what that bump is for).

**Delete:**

- `src/server/matchFilter.ts`.

**No changes:**

- `src/server/handlers.ts`, `src/server/hono.ts`, `src/server/ws.ts`
  (the legacy Hono WS wiring for `mogobase dev` — already uses the
  `useQuery`-style "re-run on change" semantics for paginated and was
  not updated when `attachWs.ts` got the window-scoped path).
- `src/client/hooks/useQuery.ts`.
- Offline paths (`db/rxdb`, `db/watermelon`, offline branch of
  `usePaginatedQuery`). The offline branch already refetches-and-replaces
  on `observeChanges`; this design simply makes online match.
- `src/dev/install.ts` — still copies the same three locations
  (`hooks/`, `api/handlers/route.ts`, `server.ts`).

## Known tradeoffs

- **Wire + parse cost.** A 1,000-row window with frequent mutations now
  sends 1,000 docs per change. Virtualization helps render but not
  serialize/parse. Consumers with very large windows should cap
  `pageSize` × loadNext depth, or debounce writes upstream.
- **Handler execution cost.** Every change event = one handler re-run.
  Same profile as `useQuery`. Offline path already does this.
- **No debouncing.** A burst of N events produces N re-runs. Deferred.
- **`sub.queue` is unbounded.** If handler runs are slower than event
  arrival, the queue can grow. Acceptable for normal mutation rates;
  if measured as a problem, coalesce adjacent refetches (keep only the
  last scheduled run, drop intermediate ones) — this is a safe
  optimization because every refetch reads current DB state anyway.

## Migration & versioning

- **Semver:** minor bump (`2.4.x` → `2.5.0`; bump already uncommitted in
  working tree). Hook files are copied into consumers via `mogobase install`;
  consumers must re-run install to pick up the new client. The server
  protocol is a strict superset of the old client (old clients receive
  `PaginatedQueryResult` on changes instead of
  `AddDoc`/`UpdateDoc`/`RemoveDoc` — the existing `PaginatedQueryResult`
  handler already does `setData(results)`, so old clients still display
  correctly without the diff handlers firing).
- **Breaking for consumer handlers:** any handler that destructures
  `args.paginationArgs` must be renamed to `args.paginationOpts`. Call
  this out in the release notes. This affects handlers that extend
  `PaginationQueryArgs` — the schema name (the runtime export) does
  **not** change, only the key it's nested under in the args object.
- **Consumer action:**
  1. Re-run `npx mogobase install` to refresh the hook files.
  2. Update each handler file in `./mogobase/*.ts` from
     `args.paginationArgs` to `args.paginationOpts`. The hook has
     always sent `paginationOpts` — only the server-side and docs were
     inconsistent, so the installed copy in `mogobase-examples` needed
     a manual patch to `paginationArgs` to work with the old server.
     That patch is now unwound in both directions.
- **Sibling updates in `mogobase-examples` (separate repo):**
  - `src/hooks/usePaginatedQuery.ts` → the `mogobase install`-copied file;
    will be overwritten on re-install. After reinstall, it'll send
    `paginationOpts` again (the source convention).
  - `mogobase/posts.ts`, `mogobase/categories.ts` → handler files that
    destructure `paginationArgs`; rename the key in both schema
    (`paginationArgs: PaginationQueryArgs` → `paginationOpts:
    PaginationQueryArgs`) and body (`const { paginationArgs } = args` →
    `const { paginationOpts } = args`; references downstream to match).

## Verification plan

- Manual smoke test in `mogobase-examples`:
  1. Home page: scroll, `loadNext` twice, trigger `createPost` from
     another tab — refetch should include the new post without the page
     collapsing to pageSize.
  2. Edit a category name in another tab — all posts on the home page
     should update `post.category?.name` without a page reload.
  3. With TanStack Virtual wired: verify `getItemKey: (i) => results[i]?._id`
     preserves scroll position across a live refetch.
- Offline path regression check: toggle provider's `online={false}`,
  verify `usePaginatedQuery` still works (it already refetches on
  `observeChanges` — we didn't touch it, but changed shared types could
  leak).
- MCP integrations: `mogobase_check_setup` / `mogobase_list_handlers`
  should still work (they don't touch the paginated code path).

## Out of scope

- Debouncing, coalescing, pagination op cancellation mid-flight.
- Server-side count estimate for virtualizer `estimateSize`.
- Opt-in incremental mode per handler.
- Changes to the Cloudflare Worker entrypoint (unused by this flow).
