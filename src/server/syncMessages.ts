// The sync messages both WebSocket transports (attachWs.ts, the legacy ws.ts) answer the same
// way: the policy check, the sync-pull and sync-push frames, and which database a sync stream
// watches. One copy, so a fix to the policy gate or a frame reaches both — the copies had
// already drifted in how they word an error.

import DB from "@/db"
import {
  evaluateSyncPolicy,
  openSyncStreamRetrying,
  policyThrew,
  pullChanges,
  pushChanges,
  requireSyncEnabled,
  subscribeSyncStream,
  syncChangeMatch,
  type SyncPolicy,
} from "./sync"
import type { StreamHub } from "./streamHub"


/** The answer to a `sync-pull` message. */
export async function syncPullFrame(
  data: any,
  headers: unknown,
  policy: SyncPolicy | undefined,
  formatError: (error: unknown) => string
): Promise<Record<string, unknown>> {
  try {
    const decision = await evaluateSyncPolicy(policy, "pull", data.model, headers)
    if (!decision.allow) throw new Error("Forbidden")
    const rs = await pullChanges({
      model: data.model,
      checkpoint: data.checkpoint ?? null,
      batchSize: data.batchSize,
      extraFilter: decision.filter,
    })
    return { type: "SyncPullResult", model: data.model, documents: rs.documents, checkpoint: rs.checkpoint }
  } catch (error) {
    return {
      type: "SyncPullResult",
      model: data.model,
      success: false,
      error: formatError(error),
      documents: [],
      checkpoint: data.checkpoint ?? null,
    }
  }
}

/** The answer to a `sync-push` message. */
export async function syncPushFrame(
  data: any,
  headers: unknown,
  policy: SyncPolicy | undefined,
  formatError: (error: unknown) => string
): Promise<Record<string, unknown>> {
  try {
    const decision = await evaluateSyncPolicy(policy, "push", data.model, headers)
    if (!decision.allow) throw new Error("Forbidden")
    const rs = await pushChanges({
      model: data.model,
      rows: Array.isArray(data.rows) ? data.rows : [],
      transform: decision.transform,
    })
    return { type: "SyncPushResult", model: data.model, conflicts: rs.conflicts }
  } catch (error) {
    return { type: "SyncPushResult", model: data.model, success: false, error: formatError(error), conflicts: [] }
  }
}

/**
 * The database a sync stream watches: the one pullChanges and pushChanges read and write — the
 * default database, whatever the request resolves to and wherever the model's live queries are
 * watched. attachWs watched the request's database (and, for a while, a model's declared
 * home): pushes landed in the default database where nobody listened, and no client heard of
 * another client's write until it reconnected.
 */
export async function syncDbName(): Promise<string> {
  await DB.connect()
  return DB.db.databaseName
}

/**
 * End a socket's sync subscription — at its close, or when the transport stops — and make a
 * sync-subscribe still running for it drop what it makes (its generation is no longer the
 * newest). One copy for attachWs's close and stop() and ws.ts's close, which had each grown one.
 */
export function endSync(state: SyncSocketState | undefined): void {
  if (!state) return
  state.syncGen = (state.syncGen ?? 0) + 1
  try {
    state.syncUnsub?.()
  } catch {}
  state.syncUnsub = undefined
}

/** What a transport keeps per socket for its sync subscription. */
export type SyncSocketState = { syncGen?: number; syncUnsub?: () => void }

/**
 * Answer a `sync-subscribe`, the same on both transports. The newest one wins: each bumps the
 * socket's `syncGen`, drops the previous subscription, and stores its own unsubscriber at once
 * (so a socket closing, or a newer sync-subscribe, ends what it opened so far) — an open landing
 * after that unsubscribes itself, and one finishing after a newer one, or after its socket closed
 * (`current()` gives undefined), unsubscribes what it made. Every model's policy at
 * once; each allowed model subscribed in the database sync uses (syncDbName), narrowed by the
 * policy's filter (subscribeSyncStream: default-deny, hub or a stream of its own).
 *
 * A model whose stream could not be opened (MongoDB unreachable as the client subscribed), or
 * whose policy threw, is tried again — 1 s, doubling to 30 s, policy asked afresh each time —
 * until it opens or the subscription ends; once open, the client is told to pull what it missed.
 * A policy's allow: false is its answer, and is not asked again. It used to be logged
 * and dropped, and the client, its socket still up, heard of no write until it reconnected. A
 * model not declared for sync is refused for good, not retried.
 */
export async function syncSubscribe(args: {
  own: SyncSocketState
  current: () => SyncSocketState | undefined
  models: unknown
  headers: unknown
  policy: SyncPolicy | undefined
  hub: StreamHub
  notify: (model: string) => void
  label: string
}): Promise<void> {
  const { own, current, headers, policy, hub, notify, label } = args
  // Ends the previous subscription; this one is the newest generation from here on.
  endSync(own)
  const gen = own.syncGen!
  const models = Array.isArray(args.models) ? [...new Set(args.models.filter((m): m is string => typeof m === "string"))] : []
  const unsubscribes: (() => Promise<void>)[] = []
  const retries = new Set<ReturnType<typeof setTimeout>>()
  let ended = false
  const unsubscribeAll = () => {
    ended = true
    for (const timer of retries) clearTimeout(timer)
    retries.clear()
    for (const u of unsubscribes.splice(0)) u().catch(() => {})
  }
  // Stored at once, not once every model's first open has settled: one model's policy hanging (a
  // session store that never answers) left it unset, and the socket's close could not end the
  // models already open. An open landing after it ran unsubscribes itself (`ended`).
  own.syncUnsub = unsubscribeAll
  // Retried by openSyncStreamRetrying (shared with streamChanges) unless refused for good.
  const subscribe = (model: string) =>
    openSyncStreamRetrying({
      model,
      label,
      what: "sync-subscribe",
      open: async () => {
        // The default-deny gate before the policy, which is often a session-store read: asked
        // first, it ran for every model a client listed, even one that could never stream.
        requireSyncEnabled(model)
        const decision = await evaluateSyncPolicy(policy, "watch", model, headers)
        if (ended) return undefined
        if (!decision.allow) {
          // The policy threw (logged): retried as a failed open is, asking it afresh. Not retried,
          // a session store's blip at connect time left the socket without live sync for good.
          if (policyThrew(decision)) throw new Error("the sync policy threw (logged above)")
          return undefined
        }
        const dbName = await syncDbName()
        return subscribeSyncStream(hub, dbName, model, () => notify(model), { match: syncChangeMatch(decision.filter) })
      },
      ended: () => ended,
      opened: (unsubscribe) => unsubscribes.push(unsubscribe),
      reopened: () => notify(model), // writes made while it could not open were seen by nothing
      timers: retries,
    })
  await Promise.all(models.map(subscribe))
  const now = current()
  if (now && now.syncGen === gen) now.syncUnsub = unsubscribeAll
  else unsubscribeAll()
}
