// What both WebSocket transports (attachWs.ts, the legacy ws.ts) must do identically: find the
// database a socket's request reads, and word an error frame by default. Kept in one place
// because a drift here is silent — a transport resolving differently reads one database and
// watches another, and answers correctly once before never updating again.

import DB from "@/db"
import { getModelDatabases } from "@/runtime/models"
import { splitWatchOptions } from "./changeStreamWatch"

/**
 * THE database a socket's request resolves to: connect, then the per-request resolver
 * (DB.setRequestResolver), or the default database without one. Used for the handler AND the
 * change streams it opens, so the two can never be bound to different databases.
 */
export async function resolveRequestDb(headers: unknown): Promise<typeof DB> {
  await DB.connect()
  return (await (DB as any)._resolveActive(headers)) as typeof DB
}

/** An error frame's text when the transport is given no formatter: the error's message. */
export function defaultFormatError(error: unknown): string {
  return `${(error as any)?.message || error}`
}

/**
 * Where a watch on `model` listens when the request resolved to `activeDbName`: the model's ONE
 * declared home (`defineModel(name, schema, { databases: ["identity"] })`) when the request's
 * database is not it, else the request's database. A model that lives in one database is read
 * there (ctx.useDatabase("identity")), so a watch on the request's database listened to an
 * empty copy: the query answered once and never updated. A predicate or several homes say
 * nothing about which one a request reads, so they keep the request's database.
 */
export function modelWatchDbName(model: string, activeDbName: string): string {
  const homes = getModelDatabases(model)
  return Array.isArray(homes) && homes.length === 1 ? homes[0] : activeDbName
}

/**
 * Where, and with what options, one ctx.watch() call watches — decided the same way on both
 * transports: mogobase's own options split from the driver's, and the database: the watch's
 * own `dbName`, else the transport's override (attachWs's `watchDatabaseFor`), else the
 * model's one declared home, else the request's database. Two copies of this had grown, one
 * per transport.
 */
export function watchTarget(
  model: string,
  options: unknown,
  active: typeof DB,
  override?: (model: string, activeDbName: string) => string | null | undefined
) {
  const { driverOptions, ignoreFields, dbName: asked } = splitWatchOptions(options)
  const activeDbName = active.db.databaseName
  const dbName = asked ?? (override?.(model, activeDbName) || modelWatchDbName(model, activeDbName))
  return { dbName, db: () => dbHandleFor(dbName, active), driverOptions, ignoreFields }
}

/** The handle for database `name`: the request's own when it is that one, else a view of it. */
export function dbHandleFor(name: string, active: typeof DB): typeof DB {
  return name === active.db.databaseName ? active : (DB.useDatabase(name) as typeof DB)
}
