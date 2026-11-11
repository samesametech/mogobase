# Decisions to make after 4.0.0

None of these blocks the 4.0.0 release. Each is written up during the review loop; pick
them up after the release. "Rec." is the recommendation from that work.

## Owner decisions

### 1. A sync pull during a long bulk write misses the rest of it

- **What happens:** a soft `deleteMany` (or `updateMany`) of many rows takes seconds to apply. A
  client that pulls meanwhile gets the rows written so far, and a checkpoint at their stamp, so it
  never gets the rest. 3.x has the same race; an advisor run showed 666 of 120 000 tombstones
  reaching a client that pulled mid-write.
- **Today:** the sync guide says to delete large sets in chunks of a few thousand rows.
- **Option A (rec.):** a `settleMs` option (default about 2000, 0 = today). A pull never answers a
  checkpoint younger than `settleMs`; a full batch whose last stamp is younger waits out the rest
  and reads again. Prototyped: 0 rows lost in that scenario.
  - Cost: a fresh row is sent again on the next pull.
  - Cost: a full fresh batch waits up to 2 s.
  - Still exposed: a write longer than `settleMs` can lose rows.
  - Tests asserting fresh checkpoints need `settleMs: 0`.
- **Option B:** leave as is; chunked deletes stay the guidance.
- **Where:** `pullChanges` in `src/server/sync.ts`; the advisor's prototype was in the session's
  scratchpad (`advisor/prototype.mjs`).

### 2. One pull answer per group of rows sharing an `updatedAt`, however large

- **What happens:** a batch never ends inside such a group (otherwise its tail was lost for good),
  so a soft `deleteMany` of N rows is one pull answer of N tombstones per client.
- **Why not bounded:** the wire checkpoint is one number. Bounding it needs a compound checkpoint
  `(updatedAt, _id)`, a protocol change: every client engine, and apps' own clients.
- **Rec.:** plan it for 5.0.0 with option 1; chunked deletes until then.

### 3. Header copies per live-query run (rounds F16 vs F17)

- **Today:** each live-query run gets its own copy of the socket's headers, so a handler's
  `ctx.headers.set(...)` stays with its run. Before, it reached every later run on the socket and
  the DB resolver: a tenant risk.
- **Cost:** a cache keyed by the headers object (a `WeakMap` of sessions) misses on every run, and
  each run builds a small `Headers` copy.
- **Rec.:** keep. The handlers guide says to key such caches by the cookie or authorization value.
- **Alternative:** a frozen per-socket view (writes throw) keeps identity but breaks code that
  writes to headers.

### 4. Index specs from several definitions add up (round 8 vs F14)

- **Today:** decided for 4.0.0. Every distinct spec any `defineModel` call declares is built, as
  3.x built each definition. "Latest definition wins" could lose a unique index declared in another
  file.
- **Cost:** removing a spec from one file keeps it while another file declares it; in development,
  until a restart.
- **Nothing to do** unless you want "latest wins" back for a reason not covered here.

## Follow-ups (engineering, no product decision)

- **Live-query slot lifecycle:** generations, `skipped`, `lingering` and `tails` guard runs of
  replaced subscriptions. A per-subscription `AbortSignal`, or a fresh slot per subscription, would
  replace most of them. Behaviour is covered by tests; this is a refactor.
- **Insert write-back heuristics:** `insertOne` writes the stored `_id` and stamps onto the caller's
  object, and WeakMaps tell a reused or spread object from a new one. Returning the stamps instead,
  or an opt-in, would remove the guessing. Owner-requested behaviour, so not changed.
- **One retry helper:** the engine, the hub and own sync streams each run a reopen-with-backoff
  loop; only `backoffDelay` is shared.
- **Known limits** (CHANGELOG.md):
  - RxDB compares `v.decimal128()` strings as text;
  - bulkWrite's soft deletes count in `modifiedCount`;
  - `defineModel` before `connect()` builds indexes twice.

## marvelous_e_app, when it moves to 4.0.0

1. `yarn add mogobase@^4.0.0`. Do not run `npx mogobase install`: it would overwrite the
   customised hooks.
2. **Merchant-facing error text.** `app/api/v1/lib.ts:112` and `mogobase/lib/mcp.ts:445` forward
   "Invalid args…" verbatim, and 4.0.0 adds field paths (`Invalid args: enabledEvents: …`);
   `tests/payments.test.ts:113` pins the old text. Keep 3.x's wording:
   ```ts
   const issues = (err as any)?.issues as { message: string }[] | undefined
   const message = issues?.length ? `Invalid args: ${issues[0].message}` : (err as Error).message
   ```
3. **Decide `maxRerunRows`** for the 44 `usePaginatedQuery` screens. A list scrolled past 1000 rows
   shrinks to 1000 on a change; `maxRerunRows: Infinity` in `server.ts` keeps 3.x behaviour.
4. **Optional, one socket per tab:** replace `hooks/wsConnect.ts` with a tab-wide socket where each
   query is a `sid`. Keep `openResilientWs`'s signature, so `useQuery` and `lib/query-store` stay.
   1. Count UNAUTHORIZED redials per query, not per socket. Per socket, a sibling's good answer
      reset the count and a truly refused query redialled forever.
   2. Redial a silent socket only when it has received nothing at all: one slow query must not
      redial the tab.
   3. `usePaginatedQuery` sends its loads through the connection, which adds the sid.
   4. `server.ts`: `maxSubscriptionsPerSocket: 64` (the query store keeps up to 20 idle
      subscriptions beside the active ones).
   5. Keep the full page reload on a Test/Live switch: the cookie rides the socket's handshake.
   - Protocol: `mogobase://guide/protocol`, "One socket per tab: moving a client over".
