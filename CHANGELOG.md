# Changelog

## 4.0.0

A major release, centred on four things:

- many live subscriptions on one WebSocket;
- sync that works and reconnects with zero configuration;
- a bounded cost per write for live queries;
- a long list of correctness fixes.

**Upgrading:** read `mogobase://guide/upgrading` (`src/mcp/guides/upgrading.md`). For every change it gives:

- how to find it in an app (a search pattern);
- the fix;
- how to check it.

An app's AI agent can follow it step by step. The `upgrade-mogobase` MCP prompt starts that workflow. Requirements: MongoDB 4.2+. Do not re-run `npx mogobase install` to refresh templates: it overwrites customised files.

### Breaking changes, each with its one-line fix

Most apps need no change. IDs match the upgrading guide.

#### Sync

| ID | Change | Fix |
| --- | --- | --- |
| S1 | `streamChanges` / `sync-subscribe` are default-deny: a model not declared `sync: true` (or a time-series one) does not stream, and the policy is not asked for it. | `defineModel(name, schema, { sync: true })` |
| S2 | Sync streams watch the default database (the one pull/push use), not the request resolver's. | None; multi-tenant sync is not supported, so keep synced models in the default database. |
| S3 | A policy-filtered sync stream no longer forwards hard deletes to every tenant. | Delete through `ctx.db` (a soft delete on a sync model). |
| S4 | The policy `filter` narrows sync streams on both transports, `$expr` included. A filter using `$where`/`$text`/`$near` leaves its stream unnarrowed, with a warning. | Check each filter selects only the rows its user may see. |
| S4b | The deprecated `filterToWatchPipeline` prefixes fields inside `$or`/`$and`/`$nor`, and keeps a filter a stream cannot run (fails closed). | None. |
| S5 | A policy that throws or returns a non-object is a logged denial; over HTTP that is 403 (was 400 with the error text). | `return { allow: false }` on every path. |
| S6 | The sync route template asks the policy through `evaluateSyncPolicy` (a throw is a logged 403, not a 400 carrying its text). | In a route copied before 4.0.0: `await evaluateSyncPolicy(syncPolicy, op, model, request.headers)`. |
| S7 | A sync-subscribe (and `streamChanges`) whose policy threw or whose stream failed to open is retried (1 s → 30 s). | Refuse with `{ allow: false }`, not a throw. |
| S8 | Deleting an already soft-deleted row is a no-op (`deletedCount: 0`, `updatedAt` kept). | None. |
| S9 | `sync: true` + `timeseries` is refused even across two `defineModel` calls. | Remove one option. |
| S10 | A pull answer can be longer than `batchSize`: a group of rows sharing one `updatedAt` comes whole (a soft `deleteMany` larger than a batch lost its tail). Rows with a Date `updatedAt`, or none and a numeric `createdAt`, are pulled in order; rows with a string `updatedAt`, a Date/string `createdAt` and none, or no stamp come in a first pull only, warned (`<model> has rows sync cannot page`). | Own sync clients: keep pulling while `documents.length >= batchSize`. Stamp unpageable rows with `$$NOW`, in chunks (sync guide). |

#### Headers (compatible)

| ID | Change | Fix |
| --- | --- | --- |
| H1 | The resolver, sync policies and WebSocket handlers' `ctx.headers` get a `headerView`: a Fetch `Headers` copy carrying Node's plain lowercase keys too. It is a superset of both 3.x shapes. A header named like a member (`get`, `keys`) is read with `get(name)`. | Code that writes to the headers object now writes to a copy: pass values on explicitly. |

#### Writes through `ctx.db`

| ID | Change | Fix |
| --- | --- | --- |
| W1 | Replaces keep the row's `createdAt` / `deletedAt`. They run as an update pipeline (MongoDB 4.2+), so the change event is usually `update`. | Watch `operationType: { $in: ["update", "replace"] }`. |
| W2 | `insertOne` / `insertMany` write the stored `_id` and stamps back onto the object passed in. | Insert a copy (`{ ...doc }`) if the object must stay untouched. |
| W3 | Refined `dbValidation` schemas validate replaces and `$set`; `$set` used to throw. | Remove workarounds for that throw. |

#### Live queries

| ID | Change | Fix |
| --- | --- | --- |
| L1 | A paginated re-run re-reads at most `maxRerunRows` (1000). | `maxRerunRows: Infinity` |
| L2 | A burst of writes re-runs at least every `refetchMaxWaitMs` (1000 ms). | `refetchMaxWaitMs: Infinity` |
| L3 | A socket over `maxBufferedBytes` (1 MiB) gets no change re-runs until it drains. | `maxBufferedBytes: Infinity` |
| L4 | `stop()` closes client sockets with 1001. | Clients reconnect on 1001. |
| L5 | A bad numeric option falls back to its default, with a warning; limits are taken whole. | Pass numbers. |
| L6 | Watches the shared stream cannot run get a stream (and a pooled connection) of their own, logged once. One using `$where` / `$text` / `$near` watches its whole collection (it was left unwatched). | Rewrite hot filters with the supported operators, or raise `maxPoolSize`. |

#### Filters (hub matcher, offline WatermelonDB)

| ID | Change | Fix |
| --- | --- | --- |
| F1 | Filters match as MongoDB does: arrays, dotted paths through arrays, RegExp values, numbers across BSON types, type bracketing for ranges, `$gt: null` matches nothing, embedded documents in key order. | Fix filters that relied on loose JS comparison. |
| F2 | WatermelonDB compares and sorts `v.decimal128()` fields by value. | None. |
| F3 | An empty or non-array `$and` / `$or` / `$nor` throws. | Leave the operator out when its list is empty. |

#### Errors and registration

| ID | Change | Fix |
| --- | --- | --- |
| E1 | "Invalid args" lists every failing field with its path; the issues are on `error.issues`. | Match the `Invalid args: ` prefix or read `error.issues`. |
| E2 | A duplicate `internalQuery` / `internalMutation` name warns; the later one still wins. | Rename one. |
| E3 | A nameless `mutation` or unknown-type message gets its own refusal, not "Name is required". | None. |

### New

- **Many live subscriptions on one WebSocket.**
  - A request may carry a client-chosen `sid`, and each sid is its own subscription.
  - `unsubscribe { sid }` ends one, answered with `Unsubscribed`.
  - Every frame for a sid echoes it, and `ended: true` marks the frame that ends it.
  - Without `sid`, nothing changes.
  - Protocol: `mogobase://guide/protocol`.
- **`rid`**: sent on a request, it is echoed on that request's answer.
- **New `attachMogobaseWebSocket` options:**

  | Option | Default |
  | --- | --- |
  | `refetchMaxWaitMs` | 1000 |
  | `maxRerunRows` | 1000 |
  | `maxBufferedBytes` | 1 MiB |
  | `maxSubscriptionsPerSocket` | 32 |
  | `maxConcurrentRunsPerSocket` | 4 |
  | `turnTimeoutMs` | 5000 |
  | `serverSideWatchFilters` | false |

  Legacy dev server: `ws.setLiveQueryOptions(...)`, which takes the same names. Every option, with how to choose values: `mogobase://guide/configuration`.
- **`ctx.watch` options:** `ignoreFields` and `dbName`.
- **Indexes:**
  - the `stampIndexes` and `databases` model options;
  - `DB.setModelDatabases`, `DB.livesIn`, `DB.diffIndexes`, `DB.dropUndeclaredIndexes`, `DB.indexReport` and `DB.onIndexError`;
  - a spec that fails no longer blocks the rest;
  - builds that fail because the cluster is unavailable are retried from 15 s up to 4 min.
- **Exports:** `headerView` / `HeaderView`, `evaluateSyncPolicy`, `syncChangeMatch`, and the `InvalidArgsError` / `ArgsIssue` types.
- **`DataLoaderGenerate`** loads string ids.
- **Offline adapters** expose `decimalFields`, and the paging polyfill orders decimal fields by value.
- **MCP:** new guides `upgrading`, `configuration` and `protocol`, and a new prompt `upgrade-mogobase`.

### Fixed

- **Sync with zero configuration, proven by integration tests:**
  - RxDB and WatermelonDB clients that lose the socket reconnect, pull, and receive later changes;
  - a sync stream that dies reopens and makes clients pull;
  - no option needs to be set.
- **Live queries:**
  - watches are registered on every run, not only the first;
  - a dead or failed watch reopens itself on a backoff;
  - a subscription catches up after it opens a new watch;
  - a watch counts as open only once its stream runs on the server;
  - loads answer with their own rid;
  - paginated re-runs past 300 rows read in pages and keep the window's start and sort;
  - a filter the hub cannot run gets a stream of its own instead of throwing.
- **Sync pull (wrong in 3.x too):**
  - a soft `deleteMany` larger than a batch no longer loses its tail, since a batch never ends inside a group of rows sharing one `updatedAt`;
  - rows with a Date `updatedAt` (an import's, or `new Date()`) are pulled after the first pull too;
  - rows with no `updatedAt` are pulled in order, by `createdAt`, so they no longer make a batch skip older rows;
  - a full batch of rows with no timestamp no longer makes a client pull the same rows forever;
  - each read is an index range sorted on one field;
  - a client's `batchSize` is made a whole number.
- **Sync streams:**
  - a policy filter using `$jsonSchema` works;
  - one using `$where`, `$text` or `$near` watches the whole collection instead of retrying a stream that cannot start;
  - a refused model is logged once, not once per message.
- **Shared streams:** they reconnect with backoff after an error or an unrequested close, resync every subscriber, and resolve a subscribe only once the stream runs.
- **autoStamp:**
  - `findOneAndReplace` is stamped;
  - wrapping twice is a no-op;
  - bulkWrite's soft deletes keep `collation` / `hint`;
  - refined schemas validate.
- **DB:**
  - one client per URI;
  - `disconnect()` waits for a `connect()` in flight and cancels retries;
  - models are built from their merged definition;
  - a model first used where it did not live yet is built once it does.
- **Handlers:** a nested `ctx.runQuery` registers its watches on the caller's run, in the database it ran against.
- **Client:**
  - the provider defines each model once, from its merged definition;
  - RxDB keeps the adapter it built.

### Known limits

- A sync pull never ends inside a group of rows sharing one `updatedAt`, so a soft `deleteMany` of N rows is one pull answer of N tombstones. Bounding it needs a compound checkpoint, which is a protocol change. Delete very large sets in chunks.
- A client that pulls while a long bulk write is still being applied gets the rows written so far and never the rest; 3.x behaves the same. Holding checkpoints back a few seconds would close this, at a cost to every pull. Delete in chunks.
- Rows a pull cannot page (a string `updatedAt`, no `updatedAt` with a Date or string `createdAt`, or no timestamp) come in a client's first pull only, as in 3.x. The server warns; stamp them with `$$NOW`.
- On a WebSocket, each live-query run gets its own copy of the headers, so a cache keyed by the headers object misses; key it by the session value.
- RxDB compares `v.decimal128()` strings as text in filters; WatermelonDB compares them by value.
- bulkWrite's soft deletes count in `modifiedCount`, not `deletedCount`.
- Offline, a `v.decimal128()` field inside an embedded document that is compared as a whole compares as text.
- Each watch the shared stream cannot run holds a change stream and a pooled connection per subscription.
- Index specs declared in several files add up, as 3.x built every definition. Removing a spec from one file keeps it while another declares it. Pairs MongoDB refuses are reported by `DB.onIndexError`; only one name on two keys is warned at registration.
- `defineModel` before `connect()` builds indexes twice; this is harmless.
