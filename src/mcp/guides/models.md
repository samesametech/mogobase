# Models, Schemas, and Indexes

Models are MongoDB collections with optional zod schemas and indexes. Register them with `defineModel(name, schema?, indexes?)` from `mogobase/runtime`.

## Where to call defineModel

Call it at **module scope** in one of your `./mogobase/*.ts` handler files — typically at the top, above the handlers that use the model:

```ts
import { defineModel, query, mutation, v } from "mogobase/runtime"

defineModel(
  "todos",
  v.object({
    title: v.string(),
    done: v.boolean(),
    createdAt: v.number(),
    userId: v.string().optional(),
  }),
  {
    indexSpecs: [{ key: { userId: 1, createdAt: -1 } }, { key: { done: 1 } }],
  }
)

query("listTodos", {
  args: v.object({}),
  handler: async (_args, { db, watch }) => {
    watch("todos")
    return db.model("todos").find({}).toArray()
  },
})
```

`defineModel` calls are replayed into whatever `db` backend is active:

- **Online**: `MogobaseDB.defineModel(name, schema, indexes)` creates the collection if missing and applies the indexes.
- **Offline (RxDB)**: `MogobaseClientDB.defineModel(name, schema)` registers an RxDB collection.
- **Offline (WatermelonDB)**: `MogobaseWatermelonDB.defineModel(name, schema)` registers a WatermelonDB table.

## Schemas are zod v4

The `v` export is `zod/v4`. Schemas are used for:

- Documenting the shape (self-describing).
- Runtime validation in online mode before writes (via `buildFilters` and adapter helpers).
- Offline adapter integration (RxDB and WatermelonDB both use the schema).

Typical model schema patterns:

```ts
defineModel("users", v.object({
  email: v.string().email(),
  name: v.string(),
  createdAt: v.number(),
}))

defineModel("posts", v.object({
  authorId: v.string(),
  title: v.string(),
  body: v.string(),
  tags: v.array(v.string()),
  published: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number().optional(),
}))
```

Omit `_id` — MongoDB assigns `ObjectId` by default. If you want a string-keyed model, pass `_id: v.string()` and generate IDs yourself.

## Money / exact decimals — `v.decimal128()`

Never store money as a float. Use `v.decimal128()` for any monetary amount, rate,
or fee:

```ts
defineModel("invoices", v.object({
  _id: v.string(),
  currency: v.string(),
  amount: v.decimal128(),                 // "100.14"
  taxRate: v.decimal128().nullable(),     // "0.0825" | null
  lineItems: v.array(v.object({ unitPrice: v.decimal128() })),
}))
```

A `decimal128` field is a **canonical decimal string on the wire and in handler
code** (`"100.14"`), and a **BSON `Decimal128` in MongoDB**. The conversion is
automatic and lives in the autoStamp write seam (`_runMutation` path):

- **Writes** — strings on `insertOne`/`insertMany`/full-replace updates and on
  `$set`/`$setOnInsert` (including dotted-path keys like `"fee.rate"`) are
  encoded string → `Decimal128`. Nested objects and arrays are walked by the
  schema.
- **Reads** — every `Decimal128` in a `findOne`/`findOneAndUpdate` result or a
  `find()`/`aggregate()` cursor is decoded back to a string, so handlers and
  clients always see `"100.14"`, never a BSON object.

Storing the real numeric BSON type (not a string) is what makes server-side
numeric comparison/aggregation correct: `amount_gt`, `$gte`, `$sum`, `$avg`,
and cross-numeric-type matches all work, with none of the lexicographic
string-ordering surprises you get from stringified amounts. Validation accepts
`-?\d+(\.\d+)?`; pass a number and it is coerced via `String(n)` on write.
Models with no `decimal128` field pay zero codec overhead.

## Indexes

Indexes pass through to MongoDB's `createIndexes`:

```ts
defineModel(
  "events",
  v.object({ userId: v.string(), at: v.number(), type: v.string() }),
  {
    indexSpecs: [
      { key: { userId: 1, at: -1 } },
      { key: { type: 1 } },
      { key: { at: 1 }, expireAfterSeconds: 60 * 60 * 24 * 30 }, // TTL
    ],
    options: { background: true },
  }
)
```

## defineModel options

`defineModel` accepts a third options argument with security-, visibility-,
and validation-relevant flags:

```ts
defineModel(
  "posts",
  v.object({
    title: v.string(),
    content: v.string(),
    userId: v.string(),
    // server-only fields below — present in MongoDB, never shipped to clients
    auditTrail: v.array(v.any()).optional(),
    isInternal: v.boolean().optional(),
  }),
  {
    indexSpecs: [{ key: { userId: 1 } }],
    clientFields: ["title", "content", "userId"],
    sync: true,
    dbValidation: true,
  }
)
```

| Option | Effect |
| --- | --- |
| `indexSpecs` | Passed to MongoDB's `createIndexes`. The engine always adds `updatedAt`, `deletedAt`, `createdAt` indexes on top of yours — sync depends on them. |
| `clientFields: string[]` | Allowlist of fields shipped to / accepted from clients. Engine fields (`_id`, `createdAt`, `updatedAt`, `deletedAt`) are always included. Used by both `filterClientFields()` (online flow) and the sync engine (pull projection + push allowlist). Omit for no restriction. |
| `sync: true` | Opt the model into mogobase sync. Default-deny — pull/push/watch on a model without `sync: true` throws. Independent from `clientFields`. |
| `dbValidation: true` | Validate writes against the model's zod schema at the autoStamp layer. Inserts and full-replace updates are validated as full docs; `$set` / `$setOnInsert` are validated as partials; aggregation-pipeline updates are skipped. Default `false`. See "Database validation" below. |
| `timeseries: { timeField, metaField?, granularity?, … }` | Create the underlying MongoDB collection as a [time-series collection](https://www.mongodb.com/docs/manual/core/timeseries-collections/). The model's behavior changes — see "Time-series collections" below. Mutually exclusive with `sync: true`. |

Use `clientFields` whenever you have server-only fields you don't want
clients to read or write. Sync-enabled models almost always need it; online-
only models can use it too — see `filterClientFields` in the handlers guide.

## Database validation (`dbValidation`)

By default the model's zod schema is informational — it documents the shape
and drives the offline adapters' JSON schemas, but mogobase doesn't reject
out-of-shape writes at the database boundary. Set `dbValidation: true` to
turn it into an enforcement boundary:

```ts
defineModel(
  "posts",
  v.object({
    title: v.string(),
    content: v.string(),
    userId: v.string(),
  }),
  {
    dbValidation: true,
  }
)
```

What gets validated, what doesn't:

| Operation | Validated as | Notes |
| --- | --- | --- |
| `insertOne` / `insertMany` | Full doc | Run **after** auto-stamping, so engine timestamps are present in the parsed payload. |
| `updateOne` / `updateMany` with `$set` | Partial | Only the fields being set are checked. |
| `updateOne` / `updateMany` with `$setOnInsert` | Partial | Same as `$set`. |
| `findOneAndUpdate` | Same as the underlying update | |
| Full-replace update (no `$`-operators) | Full doc | |
| Aggregation pipeline update (`[{$set: ...}, ...]`) | **Skipped** | No generic way to statically check the result shape — handler must validate manually if needed. |
| `findOne` / `find` | Not applicable | Reads are never validated. |
| Sync push (`pushChanges`) | **Not gated by this flag** | Sync writes go to the raw collection and rely on the policy `transform` callback for shape enforcement. |

Validation errors throw a single `Error` with a stable prefix:

```
[mogobase] Validation failed for posts.insertOne: title: Invalid input: expected string, received number; userId: Invalid input: expected string, received undefined
```

Inside a handler this surfaces as a normal rejected mutation — the WS frame
returns a `MutationResult` with the error message, and the offline backends
treat it as a write failure.

When to turn it on:

- You want defense in depth on top of the handler's `args` schema (the args
  schema only checks the public surface; internal `db.model(name).insertOne`
  calls bypass it).
- You want a fast feedback loop on schema drift — adding a required field to
  the model schema without updating handlers gives you a clear runtime error
  instead of silently storing rows missing that field.

When to leave it off:

- The model has handlers that assemble docs piecemeal (e.g. multi-step
  upserts where intermediate states wouldn't pass full-doc validation).
- You rely on aggregation-pipeline updates that the flag intentionally skips
  — keep the schema as documentation, not enforcement.

## Time-series collections

Set `timeseries` on the options to create the underlying MongoDB collection as
a [time-series collection](https://www.mongodb.com/docs/manual/core/timeseries-collections/)
— good for sensor readings, event metrics, financial ticks, anything that's
write-mostly and bucketable by time:

```ts
defineModel(
  "sensor_readings",
  v.object({
    sensorId: v.string(),
    value: v.number(),
    ts: v.date(),         // your timeField
  }),
  {
    timeseries: {
      timeField: "ts",
      metaField: "sensorId",
      granularity: "seconds",
      // expireAfterSeconds: 60 * 60 * 24 * 30, // optional TTL
    },
  }
)

mutation("recordReading", {
  args: v.object({ sensorId: v.string(), value: v.number(), ts: v.number() }),
  handler: async (args, { db }) => {
    return db.model("sensor_readings").insertOne({
      sensorId: args.sensorId,
      value: args.value,
      ts: new Date(args.ts),
    })
  },
})

query("listReadings", {
  args: v.object({ sensorId: v.string(), paginationOpts: v.any().optional() }),
  handler: async (args, { db }) => {
    return await MongoPaging.find(db.model("sensor_readings"), {
      query: buildFilters({ sensorId: args.sensorId }),
      limit: 50,
      ...(args.paginationOpts || {}),
    })
  },
})
```

### `timeseries` options

| Field | Required | Effect |
| --- | --- | --- |
| `timeField` | yes | Top-level field whose value is a BSON `Date` on each measurement. Inserts without it are rejected by MongoDB. |
| `metaField` | no | Top-level field used to group measurements (e.g. a sensor ID). MongoDB auto-indexes `{metaField, timeField}`. |
| `granularity` | no | `"seconds"` / `"minutes"` / `"hours"`. Tells MongoDB how to bucket measurements internally. Mutually exclusive with the explicit `bucketMaxSpanSeconds` / `bucketRoundingSeconds` pair (6.3+). |
| `bucketMaxSpanSeconds`, `bucketRoundingSeconds` | no | Explicit bucket-span control (MongoDB 6.3+). |
| `expireAfterSeconds` | no | TTL — buckets older than this are auto-deleted. |

mogobase calls `db.createCollection(name, { timeseries: { … } })` the first
time `defineModel` is applied for that `(uri, dbName, modelName)` tuple. If a
non-timeseries collection of the same name already exists, MongoDB's create
errors and you'll see a warning in the server log — drop or rename the
existing collection before turning on `timeseries`.

### Behavior differences from regular collections

| Aspect | Regular collection | Time-series collection |
| --- | --- | --- |
| `insertOne` / `insertMany` auto-stamping | Adds `createdAt`, `updatedAt`, `deletedAt: null` | Adds `createdAt`, `updatedAt` — **no `deletedAt`** (soft-delete doesn't apply) |
| `deleteOne` / `deleteMany` in sync-enabled handlers | Rewritten to a `$set: { deletedAt }` soft-delete | **Pass through to MongoDB's native delete** — sync is forbidden for timeseries anyway |
| Auto sync-checkpoint indexes (`updatedAt`, `deletedAt`, `createdAt`) | Always applied | **Skipped** — sync isn't supported, the metaField+timeField auto-index covers the common access pattern |
| Sync (`sync: true`) | Allowed | **Forbidden** — `defineModel` throws at registration; `pullChanges`/`pushChanges`/`streamChanges` reject at runtime |
| Update semantics | Arbitrary | Restricted by MongoDB — can't update `timeField`, `metaField`-as-key, etc. In MongoDB 6.0 only inserts + deletes + non-meta-field updates are reliable; 7.0+ lifts most restrictions. |
| `_id` | Auto-generated `ObjectId` | Same — `mongo-cursor-pagination` paginates by `_id` correctly |

### Pagination and filters

Both work the same as on regular collections:

```ts
import MongoPaging from "mongo-cursor-pagination"
import { buildFilters } from "mogobase/db"

const result = await MongoPaging.find(db.model("sensor_readings"), {
  query: buildFilters({ sensorId: "alpha", value_gte: 100 }),
  limit: 50,
  paginatedField: "_id",        // or "ts"
  sortAscending: false,
})
```

`buildFilters` always injects `{ deletedAt: null }` into its output. On a
time-series collection that has no `deletedAt` field this still matches
correctly — MongoDB's `{deletedAt: null}` predicate matches documents that
don't have the field at all.

### When NOT to use `timeseries`

- You need mogobase sync — soft-delete tombstones can't propagate.
- You need arbitrary updates on individual measurements pre-MongoDB 7.0.
- You need `_id`-by-string with deterministic client IDs (sync-style). Use a
  regular collection and an index on `(timeField, metaField)`.

## ObjectId

Import `Id` from `mogobase/db` for server-side ObjectId construction:

```ts
import { Id } from "mogobase/db"
// ...
await db.model("users").findOne({ _id: new Id(someIdString) })
```

## buildFilters

`buildFilters` (from `mogobase/db`) converts a client-style filter object into a MongoDB filter — handles `$eq`, `$in`, `$gt`, array filters, etc. Useful for pagination / search query handlers.

```ts
import { buildFilters } from "mogobase/db"
// ...
const filter = buildFilters({ authorId: "u1", tags: { $in: ["react"] } })
await db.model("posts").find(filter).toArray()
```

## DataLoader batching

For N+1-prone reads (e.g. loading each post's author inside a `listPosts` handler), use `DataLoaderGenerate`:

```ts
import { DataLoaderGenerate } from "mogobase/db"

const userLoader = DataLoaderGenerate("users") // default key is _id

query("listPostsWithAuthors", {
  args: v.object({}),
  handler: async (_args, { db }) => {
    const posts = await db.model("posts").find({}).toArray()
    const authors = await Promise.all(posts.map(p => userLoader.load(p.authorId)))
    return posts.map((p, i) => ({ ...p, author: authors[i] }))
  },
})
```

Create the loader **outside** the handler (module scope) so batching works across requests. Or use a per-request loader if the user scopes matter.

## Offline caveats

If you use the WatermelonDB offline adapter, **all `defineModel` calls must run before the DB is first accessed**. Since handler files are imported once at provider boot (via `handlers={() => import("@/mogobase")}`), and `defineModel` is synchronous at module scope, this is normally automatic — as long as you don't lazy-import handler files elsewhere. See `offline-backends`.
