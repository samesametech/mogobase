# Offline Backends: RxDB vs WatermelonDB

Both backends implement the same interface: `connect(dbName)`, `defineModel(name, schema?, indexes?)`, `model(name)`, `observeChanges(name)`, default-exported singleton.

Both packages are **optional peer dependencies**. An online-only consumer installs neither. An offline consumer installs only the one they pass to `<MogobaseProvider clientDB={…}>`.

Which to pick:

| Concern | RxDB | WatermelonDB |
|---|---|---|
| Install | `yarn add rxdb` | `yarn add @nozbe/watermelondb` |
| Web (Dexie/IndexedDB) | ✅ | ✅ (via LokiJS) |
| React Native | Possible (not tested) | ✅ Battle-tested |
| Query DSL | Mongo-style filters natively | Mongo-style filters (evaluated in JS) |
| Reactive observation | Native `collection.$` | Wraps `withChangesForTables`, skips replay-on-subscribe |
| Cross-tab sync | Native (RxDB BroadcastChannel plugin) | `BroadcastChannel("mogobase-watermelon-<dbName>")` shim (provided by mogobase) |
| Bundle size | Larger | Smaller per table |
| Writes | Per-document | Per-record, batched-capable |

**Default**: RxDB. Pick WatermelonDB when you need its strengths (React Native, very large local datasets).

## Selecting the backend

Import the singleton from the matching subpath and pass it as the `clientDB` prop:

```tsx
import RxClientDB from "mogobase/client-db"

<MogobaseProvider online={false} clientDB={RxClientDB} handlers={() => import("@/mogobase")}>
```

or

```tsx
import WatermelonClientDB from "mogobase/client-db/watermelon"

<MogobaseProvider online={false} clientDB={WatermelonClientDB} handlers={() => import("@/mogobase")}>
```

Only the subpath you import lands in your bundle. The provider itself contains no references to either backend, so an online-only `<MogobaseProvider online={true}>` ships zero offline code.

## RxDB specifics

- Storage: Dexie over IndexedDB.
- Schemas: RxDB schema is derived from your zod schema. Models with no schema default to a permissive shape.
- `observeChanges(name)` wraps RxDB's `collection.$` — fires on every change event including the initial snapshot.
- `defineModel` is idempotent; safe under React strict-mode double-mount.
- Peer dep: `rxdb` (>=17.0.0).

## WatermelonDB specifics

- Storage: LokiJS adapter.
- Schema: each model is one table with two columns — `data` (JSON blob) + `deleted_at` (indexed). Filters are evaluated in JS against the decoded blob.
- `observeChanges(name)` wraps `Database.withChangesForTables([name])` and **skips the replay-on-subscribe emission** so `useQuery` doesn't loop on mount.
- **All `defineModel` calls must run before the DB is first accessed.** `defineModel` throws if called after `_ensureDb()` for an unknown model. It's idempotent for already-registered models (safe under strict-mode).
- Practical implication: register all models in `./mogobase/*.ts` at module scope (the normal pattern) and you're fine. Do not lazy-add models after the first `useQuery`.
- Peer dep: `@nozbe/watermelondb` (>=0.28.0).

## Cross-tab sync

Both backends propagate writes to open tabs of the same origin so a write in tab A shows up in tab B without a refresh.

- **RxDB**: built-in — RxDB internally coordinates via `BroadcastChannel` across tabs.
- **WatermelonDB**: each tab runs its own in-memory LokiJS instance. Loki persists to IncrementalIndexedDB, but doesn't watch IndexedDB for peer changes. To fix this, mogobase's `MogobaseWatermelonDB` opens a `BroadcastChannel("mogobase-watermelon-<dbName>")` and broadcasts every mutation as `{ op: "upsert", doc }` or `{ op: "hardDelete", id }`. Receiving tabs apply the message through `_applyUpsert` / `_applyHardDelete` on the target collection's adapter — those helpers bypass the soft-delete filter so a record soft-deleted on the peer updates `deleted_at` locally. A `_applyingRemote` flag suppresses re-broadcast in the receiver so mutations don't ping-pong. The Watermelon write still fires `withChangesForTables([name])` naturally, which drives `observeChanges(name)` subscribers in the receiving tab.

Caveats:

- Browser only. `BroadcastChannel` is not available in React Native.
- No conflict resolution — last-writer-wins by message order. If two tabs race on the same record with different values, the later message wins. Keep mutations small and field-targeted to reduce surface area.
- Messages carry the full post-mutation record so the receiver never needs to re-read; deletions (soft or hard) carry either the updated doc with `deletedAt` set or the id.
- A tab opened after a peer tab already mutated will read the current state from IndexedDB on boot (no replay needed).

## Writes go through the online handler, reads go local

The pattern is:

- **`useMutation`**: in offline mode, runs the mutation handler against `clientDB`, which writes to the local store. When the app comes back online, write-reconciliation with the server is the consumer's responsibility (mogobase does not ship sync). Common pattern: keep an outgoing-ops log and replay via an online mutation.
- **`useQuery`**: in offline mode, runs the handler against `clientDB` and re-runs on `observeChanges`.

## Filters

Both adapters expose Mongo-shaped filter methods (`find`, `findOne`, `insertOne`, `updateOne`, `deleteOne`, etc.) so handler code is identical in online and offline mode. A handler written against `db.model("todos").find({ done: false })` runs on both sides.

## When offline is over-engineered

If your app doesn't need offline reads/writes, set `online={true}` and skip both `clientDB` and `handlers`. Nothing offline ships to the browser, and you don't install `rxdb` or `@nozbe/watermelondb` at all. You still get `useQuery` / `useMutation` / live queries — just no local store.
