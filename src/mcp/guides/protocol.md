# WebSocket Protocol

The live-query and sync protocol on `/ws` — the same on `attachMogobaseWebSocket` (the Next.js custom server) and the legacy `mogobase dev` transport (`ws.ts`). Every message is one JSON object; every frame the server sends is one JSON object. Write your own client against this page.

Headers (cookies, `authorization`) ride the **WebSocket handshake**: the DB resolver, the sync policy and every handler on the socket see the handshake's headers. Messages carry no headers.

## Two ids a client may send

| Field | Shape | Meaning |
| --- | --- | --- |
| `rid` | string ≤ 200 chars, or a finite number | A request id. The answer to a run carries the `rid` that was current when the run **started**, so a client can tell the answer it asked for after a write from one already in flight. No `rid` in, no `rid` out. |
| `sid` | string ≤ 64 chars, or a finite number | A **subscription id** (4.0.0). A live query sent with `sid` lives beside the socket's other subscriptions; every frame for it carries the `sid` back. `"1"` and `1` are different sids; `null` is the same as no `sid`. |

## Many subscriptions on one socket (4.0.0)

- **Without `sid`** (every client before 4.0.0): a `query` or `paginated-query` is the socket's **default subscription**. A new one replaces the old — one subscription per socket, exactly as before.
- **With `sid`**: it gets the subscription for that sid, or replaces it if that sid already has one. `unsubscribe { sid }` removes it. Frames for it echo `sid`.
- **Mixing** is allowed: the default subscription is one more slot beside the sid'd ones. A message without `sid` (a query, a load, an unsubscribe) always means the default subscription; one with `sid` never touches it.
- An **unusable `sid`** (an object, a string over 64 characters, `NaN`) is refused with an error frame — never taken for the default subscription.
- Each subscription is on its own: its watches, page window, `rid`, backoff and catch-up. A failed run (the handler threw — access revoked, a bad argument) ends **only that subscription**; its siblings keep running.
- **Which failure ends a subscription:** a frame for a `sid` with `ended: true`. It ends the subscription of that sid **as of its `rid`**: the server held no subscription for the sid when it sent it. A request you sent for the sid after that frame's request (a newer `rid` — a re-subscribe that crossed it on the wire) is a new subscription the frame does not end: ignore an `ended` frame whose `rid` is older than the sid's latest. An `ended` frame also answers the sid's loads still waiting: they get no answer of their own. Re-subscribe with the sid to resume. Any other `success: false` frame for a sid answers one request — match it to the request by `rid` — and the sid's subscription may well be alive: the answer of a subscription the sid has since replaced (its own run failed), a load the server could not serve, a message without a `name`. Frames of the default subscription (no `sid`) carry no `ended`: as before 4.0.0, a failed re-run ends it.
- One change that matches several subscriptions re-runs each of them, once (debounced per subscription: `refetchDebounceMs`, and at least every `refetchMaxWaitMs` during a burst).
- Different subscriptions run side by side — a slow handler does not hold up the rest of the tab.
- **Limit:** at most `maxSubscriptionsPerSocket` (default 32) subscriptions per socket, the default one included. Past it, a new `sid` is refused with an error frame carrying that `sid` and `ended: true`; replacing an existing `sid` always works.
- **The limit's default** is 32: about three times the ~10 live queries a busy tab shows, and at most a third of the MongoDB driver's default `maxPoolSize` (100) even if every subscription's watch held a stream of its own (below). Raise it for a client that genuinely shows more live queries at once; lower it where clients are untrusted and watches use operators the shared stream cannot run. Every default is in the configuration guide.
- **Cost per subscription:** a watch the shared change stream can run costs a filter and a callback; one it cannot (`$elemMatch`, `$expr`, a `$project` stage; every watch on the legacy `ws.ts`) opens a change stream of its own and holds a pooled MongoDB connection — per subscription, sid'd or not. One socket with 100 such subscriptions holds what 100 sockets of one subscription each held before 4.0.0. Bound it with `maxSubscriptionsPerSocket` and the driver's `maxPoolSize`, and keep watches on hot collections to the operators the shared stream supports (see the scaling guide).
- Runs: a subscription's runs happen one at a time, in order; the handler runs of one socket's subscriptions take at most `maxConcurrentRunsPerSocket` (default 4) turns at once — a turn covers the handler run, not the watch opens after it.
- **Backpressure** is per socket: while the socket's send buffer is over `maxBufferedBytes` (default 1 MiB), change-triggered re-runs of every subscription are held — no handler run, no frame — and each subscription a change reached re-runs once when it drains. Answers to requests are always sent.
- Closing the socket ends every subscription on it; runs still waiting for a turn are dropped without running their handlers.
- **A handler that never settles** (a hung upstream call): a new `query` for the same `sid` (or, without one, the default subscription) follows the stuck run, waiting for it at most `turnTimeoutMs` (default 5 s) before it runs; `unsubscribe` frees the sid at once; a removed subscription stops counting toward the limit within 15 s. If the stuck run settles after its replacement has answered, its answer is dropped (it would show an old query's rows under new arguments); one that settles first is still sent, with its own `rid`. Give upstream calls in handlers a timeout.
- A turn is held at most `turnTimeoutMs` (default 5000 ms): a handler that never settles gives up its turn (it keeps running, outside the cap), so it cannot stop the rest of the tab — but at most `maxConcurrentRunsPerSocket` runs may be over time at once; past that a run keeps its turn. Runs the client asked for (first runs, page loads) get a turn ahead of change-triggered re-runs, and a paginated re-run takes a turn per page.
- On the legacy `mogobase dev` transport the limits are set with `ws.setLiveQueryOptions({ maxSubscriptionsPerSocket, maxConcurrentRunsPerSocket, turnTimeoutMs })` before it takes connections; every watch there is a change stream of its own.

## Client → server messages

### `query`

```json
{ "type": "query", "name": "tasks.list", "args": { "projectId": "p1" }, "sid": "tasks", "rid": 1 }
```

Runs the query handler `name` with `args`, answers with a `QueryResult`, then re-runs it on every change to what it watches (`ctx.watch`) and sends a new `QueryResult` each time. `sid`, `rid` optional.

### `paginated-query`

```json
{
  "type": "paginated-query",
  "name": "tasks.page",
  "args": { "projectId": "p1", "paginationOpts": { "limit": 50, "paginatedField": "createdAt", "sortAscending": false } },
  "sid": "taskList",
  "rid": 2
}
```

Answers with a `PaginatedQueryResult` (the first page), and after each change re-reads the loaded window — up to `maxRerunRows` rows (default 1000) — and sends a new `PaginatedQueryResult`. `paginationOpts` may carry `next` / `previous` (a cursor to start from), and every other key (`paginatedField`, `sortAscending`, `fields`, …) is passed on unchanged to every page load and re-run. Without a `limit`, the handler's own page size is used.

### `paginated-query-load-next` / `paginated-query-load-previous`

```json
{ "type": "paginated-query-load-next", "sid": "taskList", "rid": 3 }
```

Loads the page after (before) the loaded window of the paginated subscription of `sid` (the default one without `sid`) and answers with a `PaginatedQueryPage`. Its rows join the window, so later re-runs re-read them too.

### `unsubscribe` (4.0.0)

```json
{ "type": "unsubscribe", "sid": "taskList", "rid": 4 }
```

Ends the subscription of `sid` (the default one without `sid`): its watches close, nothing more is sent for it — not even the answer of a run already in flight. Answered with `Unsubscribed`, also when there was nothing to end.

### `mutation` — refused

Mutations do not travel over the socket: `POST /api/handlers` (what `useMutation` does). A `mutation` message is answered with a `MutationResult` with `success: false` naming that fix.

### `sync-subscribe`, `sync-pull`, `sync-push`

The sync engine's messages (see the sync guide):

```json
{ "type": "sync-subscribe", "models": ["todos", "notes"] }
{ "type": "sync-pull", "model": "todos", "checkpoint": 1731300000000, "batchSize": 200 }
{ "type": "sync-push", "model": "todos", "rows": [{ "assumedMasterState": null, "newDocumentState": { "_id": "t1", "text": "…" } }] }
```

Sync is per socket, not per `sid`: a new `sync-subscribe` replaces the socket's previous one.

## Server → client frames

| Frame | Shape | When |
| --- | --- | --- |
| `QueryResult` | `{ type, success: true, data, sid?, rid? }` · `{ type, success: false, error, sid?, rid?, ended? }` | A `query`'s first run and each re-run. `ended: true`: the sid's subscription is gone. |
| `PaginatedQueryResult` | `{ type, success: true, data: { results, next, previous, hasNext, hasPrevious }, sid?, rid? }` · `{ type, success: false, error, sid?, rid?, ended? }` | A `paginated-query`'s first page, and each re-run (the whole loaded window, in one page's shape). `ended: true`: the sid's subscription is gone. |
| `PaginatedQueryPage` | `{ type, success: true, direction: "next" \| "previous", data: { results, next, previous, hasNext, hasPrevious }, sid?, rid? }` · `{ type, success: false, direction, error, sid?, rid?, ended? }` | The answer to a load. `"No active paginated subscription"` when `sid` has none. |
| `Unsubscribed` | `{ type: "Unsubscribed", sid?, rid? }` | The answer to `unsubscribe`. |
| `MutationResult` | `{ type, success: false, error, sid?, rid? }` | A `mutation` message (refused). |
| `sync-stream` | `{ type: "sync-stream", model }` | Something changed in `model` for this client: pull. |
| `SyncPullResult` | `{ type, model, documents, checkpoint }` · `{ type, model, success: false, error, documents: [], checkpoint }` | The answer to `sync-pull` (`"Forbidden"` when the policy refuses). |
| `SyncPushResult` | `{ type, model, conflicts }` · `{ type, model, success: false, error, conflicts: [] }` | The answer to `sync-push`. |
| error | `{ success: false, error, sid?, rid? }` | No `type`: `"Invalid JSON"`, `"Invalid message"`, `"Name is required"`, `"Unknown type: …"`. |

Refusals carry the `sid` and `rid` of the message they answer: an unusable `sid` (`"Invalid sid: …"`, no `sid` echoed), the subscription limit (`"Too many subscriptions on this socket (at most N): unsubscribe one first"`, on the frame type the request would have got).

## One socket per tab: moving a client over

A client that opens one socket per live query keeps working unchanged. To use one socket per tab:

1. Open one socket per tab (or per app), and keep it open; reconnect it with a backoff when it closes.
2. Give each live query a `sid` unique within the tab (a counter, or a stable key per component instance), and send its `query` / `paginated-query` with it.
3. Route every incoming frame by `frame.sid` to the query's listener; frames without `sid` belong to the default subscription, if you still use one. Within a sid, the frame's `type` tells which kind of request it answers: a `PaginatedQueryPage` answers a load, which a sid now holding a plain `query` (it was replaced) did not send — drop it.
4. When the component unmounts, send `{ type: "unsubscribe", sid }` and stop routing that sid. Ignore any frame that still arrives for an unsubscribed sid.
5. To change a query's arguments, send the `query` again with the same `sid`: it replaces that subscription only. Use `rid` to tell its answer from one already in flight.
6. On reconnect, re-send every live `query` / `paginated-query` (with their sids): a new socket has no subscriptions.
7. Keep a tab under `maxSubscriptionsPerSocket` (default 32). Send a `rid` with every request. Treat a frame with `ended: true` and the sid's latest `rid` as that sid's subscription having ended (show its error, re-subscribe when it makes sense); one with an older `rid` was about a subscription you have since replaced. Treat any other `success: false` as the answer to the request with that `rid`.
