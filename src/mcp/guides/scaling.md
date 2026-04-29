# Scaling and Performance

## Architecture

Three coordinated mechanisms keep the WebSocket layer's MongoDB pressure bounded:

1. **`streamHub`** (`src/server/streamHub.ts`) — process-level singleton. Opens one unfiltered MongoDB change stream per active model. Each subscriber registers a filter and a callback. Incoming change events are evaluated in JS against each subscriber's filter (via `runtime/filterMatcher`) and only matching subscribers are notified. The stream is closed automatically when the last subscriber unsubscribes.

2. **`refetchScheduler`** (`src/server/refetchScheduler.ts`) — trailing-edge debounce per `(socket, query, args)` key. Bursts of change events fold into a single refetch. Default window is 100ms; configurable via `attachMogobaseWebSocket(..., { refetchDebounceMs })`.

3. **Backpressure** — same scheduler enforces at-most-one-in-flight-plus-one-queued refetch per key. A write storm cannot stack unbounded refetches.

## Per-process capacity

The dominant bottleneck shifts from MongoDB cursor count to either WebSocket connection count (5–10K per Node process) or MongoDB query rate from refetches.

For typical SaaS workloads (5 active queries per user, ~1 write/min/user touching ~1 query, 100ms debounce):
- ~0.08 refetch queries/sec/user
- M30: ~3K queries/sec → ~35K concurrent users
- M40: ~6K queries/sec → ~70K concurrent users

Per single Node process: ~5–10K WebSocket users comfortably; 4 nodes + M40 → ~30–50K total.

## Filter operator support

`streamHub` evaluates this set in JS:
`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$regex`, `$and`, `$or`, `$not`.

For unsupported operators (`$expr`, `$where`, `$elemMatch`, `$text`), `streamHub.subscribe` throws. Callers can fall back to the legacy per-socket pipeline path by passing a `Document[]` aggregation pipeline as the second argument to `ctx.watch(model, pipeline, options?)` — this opens a per-socket Mongo change stream with the pipeline applied server-side.

## Limitations and follow-ups

- **No cross-process sharing.** Horizontal scaling opens N parallel hubs (one per process). A Redis pub/sub layer is the next step; out of scope of the current version.
- **No request collapsing.** N clients subscribed to the same shared query still produce N parallel refetches per debounce window. Hot shared queries (global feeds, leaderboards) need result caching, not addressed here.
- **JS filter cost.** Filter evaluation runs on every change event for every subscriber on that model. With many subscribers and a high write rate, the JS evaluation cost matters; profile before deploying past 10K subscribers per model on one process.
