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
    let handler = this.queries.get(name)
    if (!handler) {
      if (allowInternal && name.startsWith("internal")) {
        handler = this._queries.get(name)
      }
      if (!handler) throw new Error(`Query ${name} not found`)
    }
    if (!ctx.db) throw new Error("ctx.db is required — pass the mogobase/db or mogobase/client-db instance")
    // Run the per-request DB resolver once at the entry boundary. Recursive
    // ctx.runQuery / ctx.runMutation calls set _resolved: true and skip this.
    const dbSingleton = getDbSingleton()
    if (!ctx._resolved && dbSingleton && ctx.db === dbSingleton) {
      const active = await (dbSingleton as any)._resolveActive(ctx.headers)
      ctx = { ...ctx, db: active, _resolved: true }
    }
    const validated = await handler.args.safeParseAsync(args ?? {})
    if (validated.success) {
      const activeDb = ctx.db
      // Wrap for the read-decode side of the autoStamp codec — decimal128
      // fields need `Decimal128 → string` on every cursor result, including
      // query paths. Write-stamping branches inside the wrapper are gated by
      // the write op name and are dead code on a read-only handler.
      const wrappedDb = wrapDbWithAutoStamp(activeDb)
      // Memoize wrapped views per-call: the underlying useDatabase(name) is
      // already cached on the singleton, but each wrapDbWithAutoStamp produces
      // a fresh Proxy, so repeat calls to ctx.useDatabase(name) must reuse the
      // same wrapped instance to preserve identity for handler-side caching.
      const useDatabaseCache = new Map<string, MogobaseDB>()
      const useDatabase = (dbName: string) => {
        let cached = useDatabaseCache.get(dbName)
        if (!cached) {
          cached = wrapDbWithAutoStamp(requireDbSingleton("useDatabase").useDatabase(dbName)) as MogobaseDB
          useDatabaseCache.set(dbName, cached)
        }
        return cached
      }
      return await handler.handler(validated.data, {
        headers: ctx.headers || null,
        db: wrappedDb,
        runQuery: (n, a, c) =>
          this._runQuery(n, a, { db: activeDb, headers: ctx.headers, _resolved: true, ...(c || {}) }, true),
        runMutation: (n, a, c) =>
          this._runMutation(n, a, { db: activeDb, headers: ctx.headers, _resolved: true, ...(c || {}) }, true),
        watch: ctx.watch || (() => {}),
        useDatabase,
        useRawDatabase: (alias: string) => requireDbSingleton("useRawDatabase").useRawDatabase(alias),
      })
    } else {
      throw new Error(`Invalid args: ${validated.error.issues[0].message}`)
    }
  }

  // See `_runQuery` for the `allowInternal` rationale — same trust boundary.
  async _runMutation(name: string, args: any, ctx: Context = {}, allowInternal = false): Promise<any> {
    let handler = this.mutations.get(name)
    if (!handler) {
      if (allowInternal && name.startsWith("internal")) {
        handler = this._mutations.get(name)
      }
      if (!handler) throw new Error(`Mutation ${name} not found`)
    }
    if (!ctx.db) throw new Error("ctx.db is required — pass the mogobase/db or mogobase/client-db instance")
    const dbSingleton = getDbSingleton()
    if (!ctx._resolved && dbSingleton && ctx.db === dbSingleton) {
      const active = await (dbSingleton as any)._resolveActive(ctx.headers)
      ctx = { ...ctx, db: active, _resolved: true }
    }
    const validated = await handler.args.safeParseAsync(args ?? {})
    if (validated.success) {
      const activeDb = ctx.db
      const wrappedDb = wrapDbWithAutoStamp(activeDb)
      const useDatabaseCache = new Map<string, MogobaseDB>()
      const useDatabase = (dbName: string) => {
        let cached = useDatabaseCache.get(dbName)
        if (!cached) {
          cached = wrapDbWithAutoStamp(requireDbSingleton("useDatabase").useDatabase(dbName)) as MogobaseDB
          useDatabaseCache.set(dbName, cached)
        }
        return cached
      }
      return await handler.handler(validated.data, {
        headers: ctx.headers || null,
        db: wrappedDb,
        runQuery: (n, a, c) =>
          this._runQuery(n, a, { db: activeDb, headers: ctx.headers, _resolved: true, ...(c || {}) }, true),
        runMutation: (n, a, c) =>
          this._runMutation(n, a, { db: activeDb, headers: ctx.headers, _resolved: true, ...(c || {}) }, true),
        useDatabase,
        useRawDatabase: (alias: string) => requireDbSingleton("useRawDatabase").useRawDatabase(alias),
      })
    } else {
      throw new Error(`Invalid args: ${validated.error.issues[0].message}`)
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

export function internalQuery(name: string, c: QueryHandler) {
  if (Handlers._instance._queries.has(name)) {
    throw new Error(`Handler ${name} already exists`)
  }
  Handlers._instance._queries.set(`internal.${name}`, c)
}

export function internalMutation(name: string, c: MutationHandler) {
  if (Handlers._instance._mutations.has(name)) {
    throw new Error(`Handler ${name} already exists`)
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
