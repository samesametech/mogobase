# Scaling and Performance

## Architecture

Three coordinated mechanisms keep the WebSocket layer's MongoDB pressure bounded:

1. **`streamHub`** (`src/server/streamHub.ts`) — one per `attachMogobaseWebSocket` (plus one for sync on the legacy transport). Opens one MongoDB change stream per active **(database, model)** — not per model: with a per-request resolver, the same model watched in three databases is three streams. Each subscriber registers a filter and a callback. Incoming change events are evaluated in JS against each subscriber's filter (via `runtime/filterMatcher`) and only matching subscribers are notified. The stream is closed automatically when the last subscriber unsubscribes.

2. **`refetchScheduler`** (`src/server/refetchScheduler.ts`) — trailing-edge debounce per socket. Bursts of change events fold into a single refetch. Default window is 100ms (`refetchDebounceMs`), with a **max wait of 1 s** (`refetchMaxWaitMs`): a burst whose writes arrive closer together than the debounce (a webhook burst, an import) still re-runs every second instead of freezing every subscriber's updates until it ends.

3. **Backpressure** — the scheduler allows at most one refetch in flight plus one queued per socket, so a write storm cannot stack unbounded refetches. A socket whose send buffer is over `maxBufferedBytes` (default 1 MiB) — a client reading slower than its frames arrive — gets no change-triggered re-runs at all (no handler run, no frame) until it drains; then one re-run catches it up. Answers to its own requests are always sent.

4. **Bounded paginated re-runs** — a change re-reads at most `maxRerunRows` rows of a paginated subscription (default 1000, never below its first page), whatever the client scrolled. Past the cap the list shrinks to the cap with `hasNext: true` (see the hooks guide for the scroll-jump trade-off). Without the cap the loaded window, which the client grows at will, set the cost of every write.

## Connections: size the pool for the streams

Every open change stream holds one pooled MongoDB connection for its `awaitData` getMore, idle or not. Per Node process (per replica of your app):

- **shared streams = watched models × databases they are watched in.** 47 watched collections in 3 databases is up to 141 connections held by streams alone, before a single query runs.
- **plus one stream per subscription** (per socket before 4.0.0, when a socket held one; with `sid`s, per subscription — one socket can hold many) for every watch the hub cannot evaluate — `$elemMatch`, `$expr`, `$size`, `$all`, `$mod`, `$type`, or a pipeline stage other than `$match` (`$project`, …). These scale with sockets, not collections: 500 sockets on such a watch are 500 connections. mogobase logs this once per (database, collection, reason), naming the operator: `a live-query watch on db.orders uses operator $elemMatch, which the shared change stream cannot evaluate…`. Rewrite such filters with the supported operators on any collection many clients watch.
- **plus the connections your queries need.**

The driver's `maxPoolSize` defaults to **100** per MongoClient. Set it above streams + query concurrency (e.g. `MONGO_URI=…?maxPoolSize=300`), or streams will wait for connections and queries will queue behind them. Each database a request resolver binds shares the default cluster's pool.

**`serverSideWatchFilters` does not reduce the stream count.** It changes what each stream carries, not how many there are: still one per (database, model), its `$match` one `$or` branch per distinct subscriber filter (a large `$in` per user means a large `$match`), falling back to an unfiltered stream as soon as one subscriber is unfiltered or uses a filter only the JS matcher takes, and a reopen (when the set of filters changes) briefly holds two connections — the new stream opens before the old one closes.

## Cutting what each change costs

Two opt-in tools, for collections with many writes that subscribers do not care about — crons and background jobs stamping rows:

- **`ignoreFields` on a watch** (see the handlers guide): an update that changed only those fields (plus `updatedAt`) does not re-run that subscriber's query. This removes the expensive part — the handler re-runs and frames — for stamps on rows the subscriber does watch. It costs nothing to adopt and is per watch.
- **`attachMogobaseWebSocket(server, "/ws", { serverSideWatchFilters: true })`**: each shared stream's `$match` becomes the OR of the live subscribers' filters, so a change no subscriber in this process matches is never sent to it, and the full document is looked up only when a subscriber filters on it. Measured (integration test `streamHub.serverFilters`): one subscriber watching org `a`, 50 updates to org `b` and 1 to org `a` — the default stream delivers 51 events to the process, each with its full document; the filtered stream delivers 1. The saving per process is the share of writes on watched collections that no subscriber in that process matches. It does NOT remove MongoDB's own work: the lookup still runs for each update when any subscriber filters on the document, and the filter is evaluated by the server instead.

  The cost: when the set of distinct subscriber filters on a (database, model) changes, its stream reopens (coalesced over `reopenDelayMs`, 50 ms), resuming from a resume token so nothing in between is lost — from where the first new subscriber joined, so a write right after a subscribe still reaches it. A subscriber that joined a stream with no resume point yet gets a `"resync"` (its query re-runs); after a stream error the stream reopens fresh and every subscriber re-runs. An unfiltered watch, or a filter only the JS matcher accepts (a top-level `$not`), drops the server `$match` for its stream. JS matching still runs per subscriber, so routing is unchanged. Best for many writes to rows few subscribers watch; a subscriber set that changes every few milliseconds pays for it in reopens.

## Sockets per tab (4.0.0)

Before 4.0.0 a socket carried one live subscription, so a tab showing ten live queries held ten WebSockets — ten TCP connections, ten `ws` objects with their send buffers, ten heartbeats, ten handshakes running the resolver — and the socket count, not MongoDB, was the first wall: every replica's memory grew with tabs × live queries.

A socket now carries many subscriptions, each with a client-chosen `sid` (see the protocol guide). One socket per tab:

- **Per socket** (paid once per tab): the TCP connection and TLS state, the `ws` object and its send buffer (backpressure is per socket: `maxBufferedBytes`), a heartbeat, the handshake's headers.
- **Per subscription** (paid per live query): its last answer's arguments and page window, its watches — each a hub subscription (a filter and a callback, no stream of its own) or, for a filter the hub cannot run, a change stream and a pooled connection (see "Connections") — and its retry and debounce timers.

So moving a tab from ten sockets to one removes nine sockets' fixed cost; the per-subscription cost is unchanged. Change streams are per (database, model), not per socket, either way.

Runs of one socket's subscriptions are capped at `maxConcurrentRunsPerSocket` (default 4) at once, so a tab opening fifty live queries does not take fifty pooled connections at the same moment; and `maxSubscriptionsPerSocket` (default 32) bounds what one socket can hold.

## Per-process capacity

The dominant bottleneck shifts from MongoDB cursor count to either WebSocket connection count (5–10K per Node process) or MongoDB query rate from refetches.

For typical SaaS workloads (5 active queries per user, ~1 write/min/user touching ~1 query, 100ms debounce):
- ~0.08 refetch queries/sec/user
- M30: ~3K queries/sec → ~35K concurrent users
- M40: ~6K queries/sec → ~70K concurrent users

Per single Node process: ~5–10K WebSocket users comfortably; 4 nodes + M40 → ~30–50K total.

## Filter operator support

`streamHub` evaluates this set in JS:
`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$regex`, `$and`, `$or`, `$nor`, `$not` — the way MongoDB does: a field holding an array matches when any element does (`{ tags: "x" }`), a dotted path runs through arrays of documents (`items.sku`), a RegExp value is a regex match, numbers compare by value across number, Decimal128 and Long (`{ price: 5 }` matches `Decimal128("5.0")`), `$gt`/`$lt` compare within one type (null, `"25"` and `false` are not below 10; `$gt: null` matches nothing, `$gte: null` only null or missing), and `$options` applies to a RegExp `$regex` too. A `$regex` JavaScript cannot compile — MongoDB's `x` option, PCRE syntax such as `(?i)` — goes to a stream of its own, like the operators below. The integration test `filterMatcher.parity` runs each case against MongoDB itself.

For operators the JS matcher does not support (`$expr`, `$elemMatch`, `$size`, `$all`, `$mod`, `$type`) or a pipeline with other stages, the watch gets a per-socket MongoDB change stream with the filter as its `$match`, evaluated by MongoDB — automatically (it used to throw at subscribe and leave the query unwatched). **That is the cliff:** each such watch is one more open change stream and one more pooled connection per subscriber (see "Connections" above). It is logged once per (database, collection, reason). Prefer the supported operators on hot collections.

`$where`, `$text` and `$near`/`$nearSphere` cannot run in any change stream: a watch (or a sync policy filter) using one watches its **whole collection** on the shared stream instead — every write to the collection re-runs the query (or makes sync clients pull), logged once per (collection, operator). Nothing leaks (the handler, or the pull, applies the real filter); it costs re-runs. Express such a watch with other operators to narrow it.

## Tuning knobs (`attachMogobaseWebSocket(server, "/ws", { … })`)

| Option | Default | What it bounds |
| --- | --- | --- |
| `refetchDebounceMs` | 100 | quiet gap that folds a burst of changes into one re-run |
| `refetchMaxWaitMs` | 1000 | longest a burst may hold a re-run back |
| `maxRerunRows` | 1000 | rows a paginated re-run re-reads (never below its first page) |
| `maxBufferedBytes` | 1 MiB | send buffer above which a socket's re-runs are held |
| `maxSubscriptionsPerSocket` | 32 | live subscriptions one socket may hold (the default one and every `sid`'s) |
| `maxConcurrentRunsPerSocket` | 4 | handler runs of one socket in flight at once |
| `turnTimeoutMs` | 5000 | the longest one run holds one of those turns |
| `heartbeatMs` | 30 000 | ping interval; a socket missing a whole interval is dropped |
| `serverSideWatchFilters` | false | push subscriber filters into each shared stream's `$match` |

Index builds that fail because the cluster is unavailable (an election) are retried after 15 s, 30 s, 1, 2 and 4 min, each jittered ±25% so replicas that failed together do not retry together. A spec MongoDB refuses (a unique index over duplicate values) is reported through `DB.onIndexError` on every boot; the rest of the model's indexes are built in one more batch, not one collection scan per spec. Fix the data or the spec — `DB.indexReport()` lists what is missing or conflicting.

## Dropping indexes

`DB.dropUndeclaredIndexes(model, { dbName })` drops every index the model does not declare — including indexes built outside the model (a migration's, a TTL added by hand, an Atlas-suggested one). **Always run it with `dryRun: true` first**, read the list, and pass the names to spare in `keep`. In a database the model does not live in it refuses a real drop unless `shadow: true`.

## Limitations and follow-ups

- **No cross-process sharing.** Horizontal scaling opens N parallel hubs (one per process). A Redis pub/sub layer is the next step; out of scope of the current version.
- **No request collapsing.** N clients subscribed to the same shared query still produce N parallel refetches per debounce window. Hot shared queries (global feeds, leaderboards) need result caching, not addressed here.
- **JS filter cost.** Filter evaluation runs on every change event for every subscriber on that model. With many subscribers and a high write rate, the JS evaluation cost matters; profile before deploying past 10K subscribers per model on one process.
