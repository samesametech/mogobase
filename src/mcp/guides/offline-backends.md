# Offline Backends: RxDB vs WatermelonDB

Both backends implement the same interface: `connect(dbName)`, `defineModel(name, schema?, indexes?)`, `model(name)`, `observeChanges(name)`, default-exported singleton.

Which to pick:

| Concern | RxDB | WatermelonDB |
|---|---|---|
| Install | ✅ Already a dependency | ❌ Add `@nozbe/watermelondb` peer dep |
| Web (Dexie/IndexedDB) | ✅ | ✅ (via LokiJS) |
| React Native | Possible (not tested) | ✅ Battle-tested |
| Query DSL | Mongo-style filters natively | Mongo-style filters (evaluated in JS) |
| Reactive observation | Native `collection.$` | Wraps `withChangesForTables`, skips replay-on-subscribe |
| Bundle size | Larger | Smaller per table |
| Writes | Per-document | Per-record, batched-capable |

**Default**: RxDB. Only pick WatermelonDB when you need its strengths (React Native, very large local datasets).

## Selecting the backend

Pass `offlineAdapter` to the provider:

```tsx
<MogobaseProvider online={false} offlineAdapter="rxdb" handlers={() => import("@/mogobase")}>
```

or

```tsx
<MogobaseProvider online={false} offlineAdapter="watermelon" handlers={() => import("@/mogobase")}>
```

The backend is lazy-imported — only the selected one ships to the browser.

## RxDB specifics

- Storage: Dexie over IndexedDB.
- Schemas: RxDB schema is derived from your zod schema. Models with no schema default to a permissive shape.
- `observeChanges(name)` wraps RxDB's `collection.$` — fires on every change event including the initial snapshot.
- `defineModel` is idempotent; safe under React strict-mode double-mount.

## WatermelonDB specifics

- Storage: LokiJS adapter.
- Schema: each model is one table with two columns — `data` (JSON blob) + `deleted_at` (indexed). Filters are evaluated in JS against the decoded blob.
- `observeChanges(name)` wraps `Database.withChangesForTables([name])` and **skips the replay-on-subscribe emission** so `useQuery` doesn't loop on mount.
- **All `defineModel` calls must run before the DB is first accessed.** `defineModel` throws if called after `_ensureDb()` for an unknown model. It's idempotent for already-registered models (safe under strict-mode).
- Practical implication: register all models in `./mogobase/*.ts` at module scope (the normal pattern) and you're fine. Do not lazy-add models after the first `useQuery`.

## Writes go through the online handler, reads go local

The pattern is:

- **`useMutation`**: in offline mode, runs the mutation handler against `clientDB`, which writes to the local store. When the app comes back online, write-reconciliation with the server is the consumer's responsibility (mogobase does not ship sync). Common pattern: keep an outgoing-ops log and replay via an online mutation.
- **`useQuery`**: in offline mode, runs the handler against `clientDB` and re-runs on `observeChanges`.

## Filters

Both adapters expose Mongo-shaped filter methods (`find`, `findOne`, `insertOne`, `updateOne`, `deleteOne`, etc.) so handler code is identical in online and offline mode. A handler written against `db.model("todos").find({ done: false })` runs on both sides.

## When offline is over-engineered

If your app doesn't need offline reads/writes, set `online={true}` and skip `handlers` + `offlineAdapter`. Nothing offline ships to the browser. You still get `useQuery` / `useMutation` / live queries — just no local store.
