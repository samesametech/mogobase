# Upgrading mogobase

What changes between major versions, and how to find and fix each change in an app. Written to be
followed step by step by the app's AI agent.

## 3.x → 4.0.0

### Workflow (for an AI agent upgrading an app)

1. Read this guide to the end before changing anything.
2. Upgrade the package: `npm i mogobase@^4` (or `yarn add mogobase@^4`). Check that MongoDB is **4.2 or newer** (`db.version()` in mongosh; every Atlas tier is).
3. **Do not run `npx mogobase install` to refresh the templates.** It overwrites `hooks/`, `app/api/handlers/route.ts`, `app/api/sync/route.ts` and `server.ts` without asking, and apps customise those files. Apply the one-line edits below instead.
4. For each change below, run its **Find** search from the app's root (ripgrep skips `node_modules`; with grep, add `--exclude-dir=node_modules`). No match means the change does not touch the app: say so and move on. On a match, apply **Fix**.
5. Run the app's type check and tests, start the server, and read the log for the warnings listed under "Warnings to look for after boot".
6. Read `mogobase://guide/configuration` and propose any option whose 4.0.0 default does not fit the app, giving the reason for each.
7. Report to the user: which changes applied, what you changed, what you left alone and why.

Most apps need no code change: the defaults keep 3.x clients working, and a socket that sends no `sid` behaves as before.

### Sync

**S1. Sync streams are default-deny, like pull and push.** `streamChanges` and `sync-subscribe` no longer stream a model that is not declared `sync: true`, nor a time-series model. Before, they streamed any model the policy allowed (all of them when there was no policy).
- Find: `rg -n 'streamChanges|startSync|syncOptions'`, then for each model the clients sync: `rg -n 'defineModel\("<model>"'`.
- Fix: `defineModel(name, schema, { sync: true, clientFields: [...] })` in a file under `./mogobase/` that `server.ts` loads.
- Verify: no `sync-subscribe refused for <model>` or `streamChanges refused for <model>` warning in the log.

**S2. Sync streams watch the default database**, the one `pullChanges` / `pushChanges` read and write (`MONGO_DB`), whatever `DB.setRequestResolver` returns. Before, attachWs's stream followed the resolver, so it could watch a database pull never read.
- Find: `rg -n 'setRequestResolver'` and `rg -n 'sync: true'`; it applies only if both match.
- Fix: none, unless synced models live in a resolved, per-tenant database. Multi-tenant sync is not supported: keep synced models in the default database.

**S3. A sync stream narrowed by a policy `filter` no longer forwards hard deletes.** A hard delete carries no document to tell its tenant by, so it used to reach every tenant's client.
- Find: `rg -n '\.collection\.(deleteOne|deleteMany)|useRawDatabase' mogobase/` (hard deletes that bypass the wrapper).
- Fix: delete synced rows through `ctx.db.model(name).deleteOne(...)`. On a `sync: true` model that is a soft delete (`deletedAt` stamped), which every client pulls.

**S4. The policy `filter` narrows the sync stream on both transports, `$expr` included.** Before, `mogobase dev`'s ws.ts streamed every tenant's changes to every client, and a filter with `$expr` matched nothing on the stream.
- Find: `rg -n 'SyncPolicy|syncPolicy'`.
- Fix: none. Check that each model's `filter` selects exactly the rows its user may see: clients now receive only those. A filter using `$where`, `$text` or `$near` cannot narrow a change stream. Its stream watches the whole collection: the client pulls on every write to the model, and each pull still applies the filter. The warning `a sync stream on <db>.<model> uses $where, which a change stream cannot run` names the operator once. Express the filter without it to narrow the stream.

**S4b. `filterToWatchPipeline` (deprecated, exported from `mogobase/server/sync`) prefixes fields inside `$or` / `$and` / `$nor` too.** Before, they were left unprefixed and matched nothing on a change event. A filter a change stream cannot run (`$where`, `$text`, `$near`) is kept, so the caller's stream fails to open rather than widening.
- Find: `rg -n 'filterToWatchPipeline'`.
- Fix: none.

**S5. A policy that throws, or answers anything but an object, is a logged denial everywhere.** A fallthrough that returns `undefined` counts. Over HTTP (`hono.ts`, the sync route template) a throw now answers **403 Forbidden**; it used to answer 400 with the error text.
- Find: `rg -n 'syncPolicy|SyncPolicy' -A30`, and look for a path through the function that returns nothing.
- Fix: end every policy with `return { allow: false }`. A client that read the 400 body should treat 403 as "not allowed".

**S6. Sync route template: ask the policy through `evaluateSyncPolicy`.** This only matters if `app/api/sync/route.ts` was copied before 4.0.0. The old copy keeps working, but a policy that throws there answers 400 with the error text (sent to the client) instead of a logged 403.
- Find: `rg -n 'await syncPolicy\(' app src/app`.
- Fix: import `evaluateSyncPolicy` from `mogobase/server/sync` and replace `await syncPolicy({ op: "pull", model: body.model, headers: request.headers })` with `await evaluateSyncPolicy(syncPolicy, "pull", body.model, request.headers)`. Make the same edit for `"push"`.

**S7. A `sync-subscribe` whose policy threw, or whose stream failed to open, is retried** on a 1 s → 30 s backoff, asking the policy again each time. Once it opens, the client is told to pull. Before, it was dropped until the socket reconnected. The exported `streamChanges` retries the same way; it used to give up on the first failure.
- Fix: none. A policy that throws on purpose to refuse should return `{ allow: false }` instead, or it will be asked again on every retry.

**S8. Deleting a row that is already soft-deleted is a no-op** (on a `sync: true` model: `deleteOne` / `deleteMany` / `findOneAndDelete`). It returns `deletedCount: 0` and keeps the row's `updatedAt`, so clients do not pull the tombstone again.
- Find: `rg -n 'deletedCount'`.
- Fix: none, unless code relied on re-deleting to bump `updatedAt`. In that case, `updateOne` the row's `updatedAt` yourself.

**S9. `sync: true` together with `timeseries` is refused at registration**, even when the two come from different `defineModel` calls for the same model.
- Find: `rg -n 'timeseries' mogobase/`.
- Fix: remove one of the two options.

**S10. A pull answer can be longer than `batchSize`.** A batch never ends inside a group of rows that share one `updatedAt`; the rest of that group comes in the same answer. A soft `deleteMany` stamps every row with one `updatedAt`, so in 3.x a batch cut inside the group lost the rest of it for good. The bundled RxDB and WatermelonDB engines already handle this.
- Find: only apps with their own sync client: `rg -n 'documents\.length (===|==|<) ' ` near `sync-pull` / `SyncPullResult`.
- Fix: keep pulling while `documents.length >= batchSize` (not `===`).
- Rows whose `updatedAt` is a Date (an import's, or a caller's `new Date()`), and rows with no `updatedAt` but a numeric `createdAt`, are pulled in order with the rest. In 3.x a Date-stamped row was never pulled after the first pull, and a batch ending on an unstamped row skipped older rows.
- Rows a pull cannot page (a string `updatedAt`, no `updatedAt` with a Date or string `createdAt`, or no timestamp at all) come only in a client's first pull, as in 3.x. The server warns once per model: `<model> has rows sync cannot page`. A full batch of such rows no longer makes a client pull the same rows forever.
- Find: the warning, or in mongosh: `db.<model>.countDocuments({ updatedAt: { $not: { $type: "number" } } })` for each `sync: true` model.
- Fix: stamp them with the time of the fix, in chunks, using the loop in the sync guide. Stamping them with their old date would leave them behind clients' checkpoints.
- Also: a soft `deleteMany` of a very large set is one pull answer of that many tombstones for every client. A client that pulls while such a write is still being applied never gets the rest of it; 3.x behaves the same. Delete such sets in chunks of a few thousand rows (by `_id` range).
- Find: `rg -n 'deleteMany\(' mogobase/` on `sync: true` models.
- Fix: chunk any `deleteMany` that can match tens of thousands of rows.

Sync needs no option to work: both client engines (RxDB, WatermelonDB) reconnect on their own every 3 s, re-subscribe and pull; a server-side stream that dies reopens itself and makes clients pull.

### Headers (resolver, sync policy, handler `ctx.headers`)

**H1. `DB.setRequestResolver`, every sync policy, and WebSocket handlers' `ctx.headers` receive a `headerView`.** It is a real Fetch `Headers` **copy** that also carries one plain lowercase key per header, as Node's headers do. That makes it a superset of both 3.x shapes: `headers.cookie`, `headers.get("cookie")` and `instanceof Headers` all work, from every door. HTTP handlers' `ctx.headers` is still the route's own `Headers`.

Three details matter:
- A plain key reads the `Headers`' list, so its value is a string (set-cookie: a list).
- A header named like a member (`get`, `keys`, `constructor`) is read with `headers.get(name)`, not as a plain key.
- Each request gets its own copy: one live-query run (its resolver call and its handler), or one sync policy call.
- Find: `rg -n 'setRequestResolver|syncPolicy|ctx\.headers' -A10`, then look for code that **writes** to the headers object (`headers.set(`, `headers.append(`, `headers["x"] =`).
- Fix: nothing for code that reads. A write changes that request's copy only. On 3.x attachWs it changed the socket's shared object, so every later request on the socket saw it. Pass values forward explicitly instead of writing them into the headers.
- Also: a cache keyed by the headers object (a `WeakMap` of sessions) misses on every run now, since each run's copy is new.
- Find: `rg -n 'WeakMap' -A3` near `setRequestResolver`, `syncPolicy` or `ctx.headers`.
- Fix: key the cache by the session's value (`headers.get("cookie")`, the authorization header).
- Simplify (optional): code that branched on the header shape (`typeof h.get === "function" ? h.get("cookie") : h.cookie`) can read `h.get("cookie")` everywhere.

### Writes through `ctx.db`

**W1. A replace keeps the stored row's `createdAt` and `deletedAt`.** This applies to `replaceOne`, `findOneAndReplace` and bulkWrite's `replaceOne`. Before, a replace reset both: a birth date of today, and a tombstone undone on every client. A replace now runs as an update pipeline, so MongoDB 4.2+ is required, and its change event is usually `update` (still `replace` when MongoDB logs the whole document).
- Find: `rg -n 'operationType' mogobase/` (watches, and change streams of the app's own).
- Fix: where a filter takes `"replace"`, take both, `operationType: { $in: ["update", "replace"] }`.

**W2. `insertOne` / `insertMany` write the stored `_id`, `createdAt`, `updatedAt` and `deletedAt` back onto the object passed in.** A handler can then return what it inserted without reading it again. Inserting that object again, or a spread copy of it, still creates a new row with a fresh `_id`.
- Find: `rg -n 'insert(One|Many)\(' mogobase/`, and look for an object that is inserted and then compared, serialised or reused.
- Fix: none. If a caller's object must stay untouched, insert a copy: `insertOne({ ...doc })`.

**W3. `dbValidation` models with a refined schema** (`z.object({...}).refine(...)`) are validated on replace and `$set` like any other. The object's refinements run on a replace; a `$set` is checked field by field. Before 4.0.0, every `$set` on such a model threw `.partial() cannot be used on object schemas containing refinements`.
- Find: `rg -n '\.refine\(|\.superRefine\(' mogobase/`, then look for `dbValidation: true` on the same model.
- Fix: remove any try/catch or workaround written around that throw.

### Live queries

**L1. A paginated re-run re-reads at most `maxRerunRows` rows** (default 1000, never below the first page). Past the cap, the list shrinks to the cap with `hasNext: true`, and `loadNext` continues from there.
- Find: `rg -n 'usePaginatedQuery|paginated-query'`, then ask whether users scroll past about 1000 rows of one live list.
- Fix: to keep the whole window, use `attachMogobaseWebSocket(server, "/ws", { maxRerunRows: Infinity })`, at the cost of every write re-reading it.

**L2. A burst of writes re-runs a live query at least every `refetchMaxWaitMs`** (default 1000 ms). Before, it waited for a quiet gap, however long the burst.
- Fix: `refetchMaxWaitMs: Infinity` restores the old behaviour.

**L3. A socket whose send buffer is over `maxBufferedBytes` (default 1 MiB) gets no change-triggered re-runs until it drains.** It then gets one catch-up re-run per subscription. Answers to its own requests are always sent.
- Fix: `maxBufferedBytes: Infinity` restores the old behaviour.

**L4. The `stop()` that `attachMogobaseWebSocket` returns closes every client socket with code 1001.** Before, it left them open on a stopped server.
- Find: `rg -n 'attachMogobaseWebSocket\(' -A3`, and look for a call to `stop()`.
- Fix: none. Clients should treat 1001 like any other drop: reconnect.

**L5. A numeric option that is not a usable number is replaced by its default, with a warning.** That covers `NaN` from an unset env var, strings and negatives. Limits are taken whole.
- Find: `rg -n 'Number\(process\.env' server.ts`.
- Fix: pass numbers, and read the boot log. `maxRerunRows`, `maxSubscriptionsPerSocket` and `maxConcurrentRunsPerSocket` are taken whole (`100.5` → `100`).

**L6. Watches the shared stream cannot run get a change stream of their own.** These are filters using `$elemMatch`, `$expr`, `$size`, `$all`, `$mod`, `$type`, or a pipeline stage other than `$match`. Before, some threw at subscribe and left the query unwatched. Each one costs a pooled connection per subscriber, logged once.

A watch using `$where`, `$text` or `$near` (which no change stream runs) **watches its whole collection** instead: every write to the collection re-runs the query. In 3.x such a watch left the query unwatched. This is logged once per collection and operator. Inside a live watch's `$expr`, paths are the change event's: write `$fullDocument.total`.
- Find: `rg -n '\$(elemMatch|expr|where|text|size|all|mod|type)\b|\$project' mogobase/`, then keep the matches inside `ctx.watch(` calls.
- Fix: on collections many clients watch, rewrite the filter with the supported operators (scaling guide), or raise `maxPoolSize` in `MONGO_URI`.

### Filters (the shared hub's matcher, and the offline WatermelonDB adapter)

**F1. Filters match the way MongoDB does.**
- A field holding an array matches when any element does (`{ tags: "x" }`).
- Dotted paths run through arrays (`items.sku`).
- A RegExp value is a regex match.
- Numbers compare across number, Decimal128 and Long.
- Ranges compare within one type: `{ age: { $lt: 10 } }` no longer matches `null`, `"5"` or `false`.
- `$gt: null` matches nothing.
- Embedded documents compare in key order.

Live queries may now re-run for writes they missed before, and stop re-running for type-mismatched ones. Offline queries may return different rows.
- Find: `rg -n 'ctx\.watch\(' -A3 mogobase/`, and the offline handlers' filters (`rg -n '\.find\(\{' mogobase/`). Look for range operators on fields that can hold strings or null.
- Fix: nothing for a filter that is right for MongoDB. Fix a filter that only worked through loose JS comparison.

**F2. Offline WatermelonDB filters and sorts on `v.decimal128()` fields compare by value**, as on the server: `{ amount: { $gt: 10 } }` matches `"12.50"`. Other strings stay strings.
- Fix: none. RxDB still compares decimal strings as text (a known limit).

**F3. An empty or non-array `$and` / `$or` / `$nor` throws**, as MongoDB does.
- Find: `rg -n '\$(and|or|nor): \[\]'`, and filters built from a list that can be empty.
- Fix: leave out the operator when its list is empty.

### Errors and registration

**E1. "Invalid args" names every failing field**, e.g. `Invalid args: email: Invalid email address; age: Too small: expected number to be >=18`. Before, it gave the first issue's message only, without a path. The prefix is unchanged, and the issues are also on `error.issues` (`InvalidArgsError`).
- Find: `rg -n 'Invalid args'`.
- Fix: match the `Invalid args: ` prefix, or read `error.issues`, never the full text.

**E2. A second `internalQuery` / `internalMutation` of one name is reported** (`is registered twice`). The later one still replaces the earlier, as before; the duplicate check never fired in 3.x.
- Find: the boot log, or `rg -n 'internal(Query|Mutation)\("' mogobase/ | sort` and look for repeated names.
- Fix: rename one of the two (and its `runInternalQuery("internal.<name>")` callers).

**E3. Over the WebSocket, a `mutation` message always gets the `MutationResult` refusal** that names `POST /api/handlers`, and an unknown `type` always gets `Unknown type`, with or without a `name`. Before, either one without a name got "Name is required".
- Find: only apps with their own WebSocket client: `rg -n "Name is required"`.
- Fix: none.

### Warnings to look for after boot

| Log line | Meaning | Fix |
| --- | --- | --- |
| `<option>: … is not a number of at least N — using the default` | A bad option value | Pass a number. |
| `internalQuery "x" is registered twice` | Two handlers share a name | Rename one. |
| `a live-query watch on db.coll uses operator $… , which the shared change stream cannot evaluate` | That watch costs a connection per subscriber | Rewrite the filter (L6). |
| `a live-query watch on db.coll uses $text, which a change stream cannot run: it watches the whole collection instead` | Every write to the collection re-runs that query | Rewrite the watch filter without the operator (L6). |
| `sync-subscribe refused for <model>: … (logged once per model)` | A client asked to stream a model registered without `sync: true` | Declare it (S1), or stop the client asking. |
| `sync-subscribe refused for <name>: no model of that name is registered` | A client asked for a model no `defineModel` registers (at most one line a minute) | Fix the client's model list. |
| `defineModel("<model>"): two definitions name an index "<name>" on two keys` | Two files give one index name to two keys; MongoDB refuses one | Rename one. |
| `policy threw for …` / `policy returned … — denied` | The sync policy threw, or returned nothing | Return `{ allow: … }` on every path (S5). |
| `a sync stream on <db>.<model> uses $where, which a change stream cannot run` | That model's sync stream watches the whole collection | Express the policy filter without the operator (S4). |
| `sync-subscribe failed, retrying, for <model>` / `streamChanges failed, retrying, for <model>` | MongoDB was unreachable as the stream opened; it is being retried | None if it stops; otherwise check the cluster. |
| `[mogobase/ws] setLiveQueryOptions: <key> ignored` | `mogobase dev` was given an option it does not take | Use attachMogobaseWebSocket's names (configuration guide). |
| `a sync model without the updatedAt index` | `stampIndexes` turned off the index sync pulls use | Keep `updatedAt` in `stampIndexes`. |
| `<model> has rows sync cannot page` | Imported rows whose stamps an index range cannot page; only a client's first pull gets them | Stamp them with `$$NOW`, in chunks (S10, sync guide). |

### New in 4.0.0 (optional to adopt)

- **Many live subscriptions on one WebSocket** (`sid`; `unsubscribe`). A tab can use one socket instead of one per live query. See `mogobase://guide/protocol`, section "One socket per tab: moving a client over".
- **`rid`** on a request is echoed on its answer.
- **New options** with defaults that need no setting: `refetchMaxWaitMs`, `maxRerunRows`, `maxBufferedBytes`, `maxSubscriptionsPerSocket`, `maxConcurrentRunsPerSocket`, `turnTimeoutMs` and `serverSideWatchFilters`. See `mogobase://guide/configuration`.
- **`ctx.watch` options:** `ignoreFields` and `dbName`.
- **Indexes:** the `stampIndexes` and `databases` model options, plus `DB.setModelDatabases`, `DB.diffIndexes`, `DB.dropUndeclaredIndexes` (always `dryRun: true` first), `DB.indexReport` and `DB.onIndexError`.
- **Exports:** `headerView`, `evaluateSyncPolicy` and `syncChangeMatch`.
- **MCP:** the guides `upgrading` (this one), `configuration` and `protocol`, and the prompt `upgrade-mogobase`, which starts this workflow.
