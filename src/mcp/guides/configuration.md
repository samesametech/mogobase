# Configuration Reference

Every setting mogobase has, its default, and when to change it. Defaults are chosen for a typical
Next.js app (tens of live queries per tab, a few thousand users per process); an AI agent setting
mogobase up for a project should read the project's shape — how many live queries a screen shows,
how hot its collections are, how many tenants, whether clients are trusted — and set the few that
differ, rather than accept or copy every default.

## Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `MONGO_URI` | `mongodb://localhost:27017` | `DB.connect()`, and a `registerDatabase` alias without `uri`. Put the driver's `maxPoolSize` here (`?maxPoolSize=300`) — its own default is **100**, and every change stream holds one connection (see the scaling guide). |
| `MONGO_DB` | `mogobase` | The default database. |
| `MOGOBASE_PORT` | `4000` | `mogobase dev` (the standalone server) only. |
| `NEXT_MOGOBASE_URL` / `MOGOBASE_URL` | — (a browser uses `window.location` + `/ws`; off-browser `ws://localhost:3000/ws`) | Where client hooks and the sync engines connect when not in a browser (SSR, tests). |
| `NEXT_PUBLIC_HOST` / `HOST` | `http://localhost:3000` | `mogobase dev`'s CORS origin for `/api/sync`. |

## `attachMogobaseWebSocket(server, path, options)`

`path` defaults to `"/ws"`.

| Option | Default | What it does | Change it when |
| --- | --- | --- | --- |
| `syncPolicy` | none — every model declared `sync: true` may pull, push and stream | Per-operation sync authorization: `{ allow, filter?, transform? }` | Always, in production, for an app using sync (see the sync guide). |
| `refetchDebounceMs` | `100` | Quiet gap that folds a burst of changes into one re-run of a live query | Raise (250–500) on write-heavy collections whose screens tolerate a little lag; lower for chat-like latency. |
| `refetchMaxWaitMs` | `1000` | The longest a burst may hold a re-run back | Raise if continuous imports re-run lists too often; `Infinity` waits for the burst to end. |
| `maxRerunRows` | `1000` | Rows a paginated re-run re-reads (never below its first page); past it the list shrinks to the cap with `hasNext: true` | Lower for big rows or busy collections; raise (or `Infinity`) for lists users scroll far and that change rarely. |
| `maxBufferedBytes` | `1048576` (1 MiB) | A socket's send buffer above which its change-triggered re-runs are held until it drains | Lower for memory-tight replicas; raise for large frames on fast clients. |
| `maxSubscriptionsPerSocket` | `32` | Live subscriptions one socket may hold (the default one and every `sid`'s); past it a new one is refused | Raise for screens with more simultaneous live queries per tab; lower for untrusted clients, or when watches use operators the shared stream cannot run (each such subscription holds a pooled connection). |
| `maxConcurrentRunsPerSocket` | `4` | Handler runs of one socket in flight at once | Raise for dashboards whose many queries are cheap; lower to protect a small `maxPoolSize`. |
| `turnTimeoutMs` | `5000` | The longest one run holds one of those turns before giving it up (it keeps running, outside the cap; at most `maxConcurrentRunsPerSocket` runs may be over time at once, past which a run keeps its turn) — and the longest a replaced subscription's run delays its replacement | Raise if handlers legitimately run longer and the cap must hold (`Infinity`: never give a turn up); lower if a slow upstream should not delay siblings. |
| `heartbeatMs` | `30000` (`0` disables) | Ping interval; a socket missing a whole interval is dropped | Lower behind proxies that cut idle sockets sooner than 100 s. |
| `formatError` | the error's message | What a client sees of a handler error | Production: log the error and return a generic message. |
| `watchDatabaseFor` | none — the request's database (or the model's one declared home) | Which database a model's change stream opens on | A collection living in one database whatever the tenant (identity, reference data). |
| `serverSideWatchFilters` | `false` | Push subscriber filters into each shared stream's `$match` | Many writes to rows few subscribers watch (a big multi-tenant collection). |

Every numeric option is checked: the three per-socket limits and `maxRerunRows` must be numbers of at least 1, `refetchDebounceMs`, `refetchMaxWaitMs`, `maxBufferedBytes` and `heartbeatMs` at least 0 (`Infinity` allowed except for the debounce and the heartbeat). Anything else — `NaN` from an unset environment variable (`Number(process.env.X)`), a string, a negative — is replaced by its default, with a warning in the log. The three per-socket limits and `maxRerunRows` are taken whole (`100.5` is `100`). Removed subscriptions whose work is still running count toward `maxSubscriptionsPerSocket` until it settles, or for at most 15 s.

## `mogobase dev` (legacy `ws.ts` / `hono.ts`)

| Call | Default | Notes |
| --- | --- | --- |
| `setHonoSyncPolicy(policy)` / `ws.setSyncPolicy(policy)` | none | As `syncPolicy` above. |
| `ws.setLiveQueryOptions({ maxSubscriptionsPerSocket, maxConcurrentRunsPerSocket, turnTimeoutMs, maxRerunRows, maxBufferedBytes })` | `32`, `4`, `5000`, `1000`, 1 MiB | attachMogobaseWebSocket's names and defaults (not `refetchMaxWaitMs`: re-runs here are not debounced, so there is no wait to bound). Call before the server takes connections; a later call adds to an earlier one; any other key is ignored with a warning. Every watch here is a change stream of its own. |
| re-run debounce | `0` ms (fixed) | |

## `ctx.watch(model, pipelineOrFilter?, options?)`

| Option | Default | What it does |
| --- | --- | --- |
| `ignoreFields` | none | Updates touching only these fields (plus `updatedAt`) do not re-run the subscriber — a cron's stamps. |
| `dbName` | the request's database, else the model's one declared home | The database to watch; wins over everything. |
| any `ChangeStreamOptions` | — | Passed to a watch's own change stream (not `fullDocument` / `fullDocumentBeforeChange`). |

## `defineModel(name, schema?, options?)`

| Option | Default | What it does |
| --- | --- | --- |
| `indexSpecs` | none | Indexes to build (never dropped by mogobase; see `DB.dropUndeclaredIndexes`). |
| `stampIndexes` | all three (`updatedAt`, `deletedAt`, `createdAt`) | `false` for none, `{ createdAt: false }` to skip one. Sync needs `updatedAt`. |
| `sync` | `false` | Opt in to sync (default-deny). |
| `clientFields` | none — every field | The fields sync and `filterClientFields` let through. |
| `dbValidation` | `false` | Validate handler writes against the schema. |
| `timeseries` | none | Make the collection a time-series one (no sync). |
| `databases` | every database | Where the model lives: a list, or `(dbName) => boolean`. |

## `DB` (the `mogobase/db` singleton)

| Call | Default | Notes |
| --- | --- | --- |
| `setRequestResolver(fn)` | none — every request uses `MONGO_DB` | Per-request database (multi-tenant). Gets the headers as a `headerView`. |
| `setModelDatabases(rule)` | none — every model lives everywhere | App-wide `databases`; set before `connect()`. The rule (and a model's own `databases` function) runs again on each `model()` access in a database where the model does not live — so a rule that grows (a tenant added later) is followed: keep it cheap (a set lookup, not a query). |
| `registerDatabase(name, { uri?, dbName })` | `uri`: `MONGO_URI` | A raw alias for `ctx.useRawDatabase`. |
| `onIndexError(listener)` | none (failures are logged) | Alerting on index builds that fail. |
| `dropUndeclaredIndexes(model, { dbName?, dryRun?, keep?, shadow? })` | `dryRun: false`, `keep: []`, `shadow: false` | Always run with `dryRun: true` first. |
| `indexReport({ dbNames?, models? })` | every known database, every model | |

## Client (`MogobaseProvider`, `startSync`)

| Setting | Default | Notes |
| --- | --- | --- |
| `online` | — (required) | `true`: live queries over `/ws`. |
| `sync` | `false` | Local-first sync through `clientDB`. |
| `dbName` | `mogobase` | The offline database's name. |
| `syncOptions.wsUrl` | the page's origin + `/ws` | |
| `syncOptions.models` | every collection defined on the client DB | |
| `syncOptions.batchSize` | `200` | Rows per pull / push (the server caps a pull at 1000, a push at 500). |
| `syncOptions.getAuth` | none | Extra headers for `sync-subscribe` (the handshake's headers are what the server checks). |
| `syncOptions.conflictResolver` | server wins | |
| reconnect | every 3 s (fixed) | Both sync engines reconnect, re-subscribe and pull on their own. |

## Fixed internals (not settable; here so their effects are not a surprise)

| What | Value |
| --- | --- |
| Rows per page of a paginated re-run | 300 (mongo-cursor-pagination's `MAX_LIMIT`) |
| A change stream counts as open | after its first `resumeTokenChanged`, or 10 s |
| Watch / stream / sync-stream retries | 1 s, doubling to 30 s; a stream that lived 60 s forgets earlier failures |
| Shared stream: reopen coalescing (`serverSideWatchFilters`) | 50 ms |
| Backed-up socket poll | every 100 ms |
| Index build retries after a cluster failure | 15 s, 30 s, 1 min, 2 min, 4 min, each ±25% |
| `indexReport` listings in parallel | 8 |
| `rid` / `sid` | a string of at most 200 / 64 characters, or a finite number |

## Choosing values for a project

- **Many live queries per screen** (dashboards, multi-pane apps): one socket per tab with `sid`s (protocol guide); `maxSubscriptionsPerSocket` above the most a screen shows, with margin; `maxConcurrentRunsPerSocket` 4–8; `maxPoolSize` above shared streams + subscriptions with own streams + query concurrency.
- **Write-heavy collections** (webhooks, imports, metrics): `ignoreFields` on watches of stamped fields; `refetchDebounceMs` 200–500; `serverSideWatchFilters: true` if most writes concern rows few subscribers watch.
- **Long scrolled lists**: keep `maxRerunRows` near what users actually see; it bounds every write's cost.
- **Multi-tenant**: `setRequestResolver`, `databases` / `setModelDatabases` for models that live in one database, `watchDatabaseFor` for shared collections; `maxPoolSize` grows with databases × watched models.
- **Untrusted or public clients**: a real `formatError`; a `syncPolicy` for every synced model; a lower `maxSubscriptionsPerSocket` (8–16) and watches the shared stream can run (no `$elemMatch` / `$expr` on hot collections).
- **Small apps and development**: the defaults.
