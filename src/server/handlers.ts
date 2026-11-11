import z4 from "zod/v4"

import type { MogobaseDB } from "@/db"
import type { ChangeStreamOptions, Db, Document } from "mongodb"
import { wrapDbWithAutoStamp } from "@/server/autoStamp"
import { decimal128 } from "@/runtime/decimal"

// Read the MogobaseDB singleton via globalThis instead of importing it.
// A static `import` here would pull mongodb into the client bundle (this
// module is re-exported from mogobase/runtime, which the offline-path
// hooks consume). The singleton is published to globalThis the moment
// `mogobase/db` is loaded on the server.
const DB_GLOBAL_KEY = "__mogobase_db__"
function getDbSingleton(): MogobaseDB | undefined {
  const g = globalThis as unknown as Record<string, { instance?: MogobaseDB }>
  return g[DB_GLOBAL_KEY]?.instance
}
function requireDbSingleton(method: string): MogobaseDB {
  const db = getDbSingleton()
  if (!db) {
    throw new Error(
      `[mogobase] ctx.${method} requires the server runtime — import "mogobase/db" before invoking handlers.`
    )
  }
  return db
}

export type WatchOptions = ChangeStreamOptions & {
  paginatedField?: string
  sortAscending?: boolean
  /**
   * Don't re-run for an update that changed only these fields (or fields under them) —
   * e.g. a cron stamping `reconciledAt` on rows the query shows but does not display.
   * `updatedAt` joins the list automatically, since every write stamps it. Inserts,
   * deletes always re-run; a replace made through ctx.db usually arrives as an update (its changed fields checked), a `replace` event always re-runs. Omitted: every matching change re-runs, as before.
   */
  ignoreFields?: string[]
  /**
   * The database to watch, when it is not the one the request resolved to — the database the
   * handler read with `ctx.useDatabase(name)`. Without it a watch follows the request's
   * database, or the transport's `watchDatabaseFor`, or the model's one declared home.
   */
  dbName?: string
}

export type Context = {
  db?: any
  runQuery?: (name: string, args: any, ctx?: Context) => Promise<any>
  runMutation?: (name: string, args: any, ctx?: Context) => Promise<any>
  watch?: (modelName: string, pipelineOrFilter?: Document[] | Document, options?: WatchOptions) => void
  headers?: any
  useDatabase?: (dbName: string) => MogobaseDB
  useRawDatabase?: (registeredName: string) => Promise<Db>
  // Internal flag: set by recursive ctx.runQuery/ctx.runMutation calls to skip
  // the resolver (the active DB is already chosen for this request).
  _resolved?: boolean
}

export type QueryHandler = {
  args: z4.ZodType
  handler: (
    args: any,
    ctx: {
      headers?: any
      db: MogobaseDB
      runQuery: (name: string, args: any, ctx?: Context) => Promise<any>
      runMutation: (name: string, args: any, ctx?: Context) => Promise<any>
      watch: (modelName: string, pipelineOrFilter?: Document[] | Document, options?: WatchOptions) => void
      useDatabase: (dbName: string) => MogobaseDB
      useRawDatabase: (registeredName: string) => Promise<Db>
    }
  ) => Promise<any>
}

export type MutationHandler = {
  args: z4.ZodType
  handler: (
    args: any,
    ctx: {
      headers?: any
      db: MogobaseDB
      runQuery: (name: string, args: any, ctx?: Context) => Promise<any>
      runMutation: (name: string, args: any, ctx?: Context) => Promise<any>
      useDatabase: (dbName: string) => MogobaseDB
      useRawDatabase: (registeredName: string) => Promise<Db>
    }
  ) => Promise<any>
}

/** One way a handler's args failed validation, as the thrown error carries it. */
export type ArgsIssue = {
  /** Where in the args: `["customer", "email"]`, `["items", 0, "price"]`; `[]` for the args as a whole. */
  path: (string | number)[]
  /** zod's issue code: `"invalid_type"`, `"too_small"`, `"unrecognized_keys"`, … */
  code: string
  /** zod's message, without the path. */
  message: string
}

/** What a handler throws when its args fail validation: an `Error` with the issues on it. */
export type InvalidArgsError = Error & { issues: ArgsIssue[] }

/**
 * `Invalid args: customer.email: Invalid input: expected string, received undefined`
 *
 * This used to keep only the first issue's message, so a client was told what
 * was wrong but never which field, and an app could not tell a missing field
 * from a malformed one. Every issue is now named by its path, the first one
 * first, so code matching the `Invalid args: ` prefix still works; an issue with
 * the args as a whole has no path and reads exactly as before. The same issues
 * ride on the error as `issues`, for an app that maps them to its own error
 * codes instead of parsing the text.
 *
 * A plain `Error` on purpose: the HTTP route template answers with `${error}`,
 * and a custom `name` would change that body's `Error: Invalid args: ` prefix.
 */
const MAX_LISTED_ISSUES = 10

function invalidArgs(
  zodIssues: readonly { path: PropertyKey[]; code: string; message: string }[]
): InvalidArgsError {
  const issues: ArgsIssue[] = zodIssues.map((i) => ({
    path: i.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    code: i.code,
    message: i.message,
  }))
  // At most MAX_LISTED_ISSUES in the text: an array of 5,000 bad items would otherwise make a
  // message of hundreds of KB, sent to the client and logged. Every issue stays on `issues`.
  const listed = issues
    .slice(0, MAX_LISTED_ISSUES)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
  const more = issues.length - listed.length
  const text = listed.join("; ") + (more > 0 ? `; …and ${more} more` : "")
  return Object.assign(new Error(`Invalid args: ${text}`), { issues })
}

const GLOBAL_KEY = "__mogobase_handlers__"
type HandlersGlobal = { instance?: Handlers }
const g = globalThis as unknown as Record<string, HandlersGlobal>
if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = {}

class Handlers {
  static get _instance(): Handlers {
    if (!g[GLOBAL_KEY].instance)
      g[GLOBAL_KEY].instance = Object.create(Handlers.prototype, {
        queries: { value: new Map(), enumerable: true },
        mutations: { value: new Map(), enumerable: true },
        _queries: { value: new Map(), enumerable: true },
        _mutations: { value: new Map(), enumerable: true },
      })
    return g[GLOBAL_KEY].instance!
  }
  queries!: Map<string, QueryHandler>
  mutations!: Map<string, MutationHandler>
  _queries!: Map<string, QueryHandler>
  _mutations!: Map<string, MutationHandler>

  constructor() {
    return Handlers._instance
  }

  // `allowInternal` gates resolution of the in-process-only internal pool. It
  // is a function PARAMETER, never a field of the client-controllable `ctx`,
  // so a network caller cannot set it by shaping their request. Network entry
  // points — the HTTP /api/handlers route (via the public `runQuery` export),
  // /ws (attachWs/ws), and hono — call with the default `false`, so a
  // client-supplied "internal.*" name resolves nothing and 404s. Only recursive
  // ctx.runQuery/ctx.runMutation calls (already inside an authorized handler)
  // and the explicit runInternalQuery/runInternalMutation entry points pass `true`.
  async _runQuery(name: string, args: any, ctx: Context = {}, allowInternal = false): Promise<any> {
    const { handler, data, ctx: resolved } = await this._prepareRun("Query", this.queries, this._queries, name, args, ctx, allowInternal)
    return await handler.handler(data, { ...this._handlerCtx(resolved), watch: resolved.watch || (() => {}) })
  }

  // See `_runQuery` for the `allowInternal` rationale — same trust boundary.
  async _runMutation(name: string, args: any, ctx: Context = {}, allowInternal = false): Promise<any> {
    const { handler, data, ctx: resolved } = await this._prepareRun("Mutation", this.mutations, this._mutations, name, args, ctx, allowInternal)
    return await handler.handler(data, this._handlerCtx(resolved))
  }

  // What _runQuery and _runMutation do alike before the handler runs — one copy, so a fix to one
  // (the resolver, validation) reaches the other: find the handler (internal ones only for a
  // nested call), require a db, run the per-request DB resolver once at the entry boundary
  // (recursive ctx.runQuery / ctx.runMutation calls set _resolved: true and skip it), validate
  // the args.
  async _prepareRun(
    kind: "Query" | "Mutation",
    pool: Map<string, any>,
    internalPool: Map<string, any>,
    name: string,
    args: any,
    ctx: Context,
    allowInternal: boolean
  ): Promise<{ handler: any; data: any; ctx: Context }> {
    let handler = pool.get(name)
    if (!handler && allowInternal && name.startsWith("internal")) handler = internalPool.get(name)
    if (!handler) throw new Error(`${kind} ${name} not found`)
    if (!ctx.db) throw new Error("ctx.db is required — pass the mogobase/db or mogobase/client-db instance")
    const dbSingleton = getDbSingleton()
    if (!ctx._resolved && dbSingleton && ctx.db === dbSingleton) {
      const active = await (dbSingleton as any)._resolveActive(ctx.headers)
      ctx = { ...ctx, db: active, _resolved: true }
    }
    const validated = await handler.args.safeParseAsync(args ?? {})
    if (!validated.success) throw invalidArgs(validated.error.issues)
    return { handler, data: validated.data, ctx }
  }

  // The ctx a handler gets, query or mutation (a query's adds `watch`). `db` wrapped for the
  // autoStamp codec — on a query too: decimal128 fields need `Decimal128 → string` on every
  // cursor result, and the write-stamping branches are dead code on a read-only handler.
  _handlerCtx(ctx: Context) {
    const activeDb = ctx.db
    return {
      headers: ctx.headers || null,
      db: wrapDbWithAutoStamp(activeDb),
      // A nested query's watches belong to this run: without `watch` they were dropped, and a
      // live query never re-ran on a write to a collection only the nested query watched. Run
      // against another database (`c.db`), they watch that one. (A mutation's ctx has no watch.)
      runQuery: (n: string, a?: any, c?: Partial<Context>) =>
        this._runQuery(
          n,
          a,
          { db: activeDb, headers: ctx.headers, _resolved: true, watch: nestedWatch(ctx.watch, c?.db, activeDb), ...(c || {}) },
          true
        ),
      runMutation: (n: string, a?: any, c?: Partial<Context>) =>
        this._runMutation(n, a, { db: activeDb, headers: ctx.headers, _resolved: true, ...(c || {}) }, true),
      useDatabase: memoizedUseDatabase(),
      useRawDatabase,
    }
  }
}

// filename: callsite.ts
export function query(name: string, c: QueryHandler) {
  if (Handlers._instance.queries.has(name)) {
    throw new Error(`Handler ${name} already exists`)
  }
  Handlers._instance.queries.set(name, c)
}

export function mutation(name: string, c: MutationHandler) {
  if (Handlers._instance.mutations.has(name)) {
    throw new Error(`Handler ${name} already exists`)
  }
  Handlers._instance.mutations.set(name, c)
}

// The check used to look up the bare name in a map keyed `internal.<name>`, so it never fired and
// a second registration silently replaced the first. It is reported now, and still replaces: a
// throw (what query()/mutation() do) would stop an app that has one from booting.
export function internalQuery(name: string, c: QueryHandler) {
  if (Handlers._instance._queries.has(`internal.${name}`)) {
    console.warn(`[mogobase] internalQuery "${name}" is registered twice: the later registration replaces the earlier one. Rename one of them.`)
  }
  Handlers._instance._queries.set(`internal.${name}`, c)
}

export function internalMutation(name: string, c: MutationHandler) {
  if (Handlers._instance._mutations.has(`internal.${name}`)) {
    console.warn(`[mogobase] internalMutation "${name}" is registered twice: the later registration replaces the earlier one. Rename one of them.`)
  }
  Handlers._instance._mutations.set(`internal.${name}`, c)
}

// `v` is zod/v4 plus mogobase's first-class `decimal128()` builder. A
// `v.decimal128()` field validates a canonical decimal string and is
// persisted as a BSON Decimal128 by the autoStamp codec (string→Decimal128
// on write, Decimal128→string on read) — see src/runtime/decimal.ts.
// zod/v4's default export is non-extensible, so we can't attach to it
// in place — spread it into a fresh object and add `decimal128`.
export const v: typeof z4 & { decimal128: typeof decimal128 } = {
  ...z4,
  decimal128,
}

const _singleton = new Handlers()

export async function runQuery(name: string, args: any, ctx: Context = {}) {
  return _singleton._runQuery(name, args, ctx)
}

export async function runMutation(name: string, args: any, ctx: Context = {}) {
  return _singleton._runMutation(name, args, ctx)
}

// In-process-only entry points for invoking `internal.*` handlers. Trusted
// server code (trigger.dev workers, the webhook route's system-actor path,
// in-process API routes that authenticate first) imports these to reach the
// internal pool. They MUST NEVER be wired to a network handler that forwards a
// client-supplied name — `runQuery`/`runMutation` are the network-safe entry
// points and refuse the internal pool by construction.
export async function runInternalQuery(name: string, args: any, ctx: Context = {}) {
  return _singleton._runQuery(name, args, ctx, true)
}

export async function runInternalMutation(name: string, args: any, ctx: Context = {}) {
  return _singleton._runMutation(name, args, ctx, true)
}

export default _singleton

/**
 * The caller's `watch`, for a query it runs through ctx.runQuery. That watch places a watch in the
 * caller's database; a nested query given a db of its own (`{ db: ctx.useDatabase("identity") }`)
 * reads another one, so its watches are sent there — the watch's own `dbName` still wins.
 */
function nestedWatch(watch: Context["watch"], db: any, callerDb: any): Context["watch"] {
  if (!watch || !db || db === callerDb) return watch
  const dbName = databaseNameOf(db)
  // The caller's own database (ctx.db is its autoStamp wrapper, not the same object): passed on as
  // it is, so a model's declared home still decides where it is watched.
  if (!dbName || dbName === databaseNameOf(callerDb)) return watch
  return (model: string, filter?: any, options?: any) =>
    watch(model, filter, { ...(options || {}), dbName: options?.dbName ?? dbName })
}

function databaseNameOf(db: any): string | undefined {
  try {
    return db?.db?.databaseName
  } catch {
    return undefined // not connected yet
  }
}

// ctx.useDatabase for one handler call — one copy for queries and mutations. Memoized per call:
// the underlying useDatabase(name) is cached on the singleton, but each wrapDbWithAutoStamp makes
// a fresh Proxy, so repeat calls must reuse the same wrapped instance to preserve identity for
// handler-side caching.
function memoizedUseDatabase(): (dbName: string) => MogobaseDB {
  const cache = new Map<string, MogobaseDB>()
  return (dbName: string) => {
    let cached = cache.get(dbName)
    if (!cached) {
      cached = wrapDbWithAutoStamp(requireDbSingleton("useDatabase").useDatabase(dbName)) as MogobaseDB
      cache.set(dbName, cached)
    }
    return cached
  }
}

const useRawDatabase = (alias: string) => requireDbSingleton("useRawDatabase").useRawDatabase(alias)
