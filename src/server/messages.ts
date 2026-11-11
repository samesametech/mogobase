// The WebSocket message protocol, routed the same way by both transports (attachWs.ts, the
// legacy ws.ts): which message goes where, and the frames for the ones that are not live
// queries. A transport supplies its socket's wiring and nothing else. The two copies of this
// routing kept drifting — sync-subscribe, the policy check, rid echo, error wording — and each
// drift was a bug on one transport only.

import type { LiveQueries } from "./liveQuery"
import { withRid } from "./liveQuery"
import type { StreamHub } from "./streamHub"
import type { SyncPolicy } from "./sync"
import { syncPullFrame, syncPushFrame, syncSubscribe, type SyncSocketState } from "./syncMessages"

export type MessageTransport = {
  /** The socket's id in the live-query engine. */
  id: string
  /** The handshake's headers: what the resolver and the sync policy see. */
  headers: unknown
  /** Send a frame, if the socket is still open. */
  send(payload: Record<string, unknown>): void
  live: LiveQueries
  /** The socket's sync state; undefined once it has closed. */
  syncState(): SyncSocketState | undefined
  syncPolicy: SyncPolicy | undefined
  /** The hub sync streams subscribe on. */
  syncHub: StreamHub
  formatError(error: unknown): string
  /** For log lines: "attachWs", "ws". */
  label: string
}

/** Answer one message from a client. */
export async function handleMessage(raw: string, t: MessageTransport): Promise<void> {
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return t.send({ success: false, error: "Invalid JSON" })
  }
  if (!data || typeof data !== "object") return t.send({ success: false, error: "Invalid message" })
  const { type, name } = data

  if (type === "paginated-query-load-next" || type === "paginated-query-load-previous" || type === "unsubscribe") {
    t.live.handle(t.id, data)
    return
  }
  if (type === "sync-subscribe") {
    const own = t.syncState()
    if (!own) return
    return syncSubscribe({
      own,
      current: t.syncState,
      models: data.models,
      headers: t.headers,
      policy: t.syncPolicy,
      hub: t.syncHub,
      notify: (model) => t.send({ type: "sync-stream", model }),
      label: t.label,
    })
  }
  if (type === "sync-pull") return t.send(await syncPullFrame(data, t.headers, t.syncPolicy, t.formatError))
  if (type === "sync-push") return t.send(await syncPushFrame(data, t.headers, t.syncPolicy, t.formatError))

  // Only a query needs a name: checked first, a mutation without one got "Name is required" — not
  // the refusal naming the fix (POST /api/handlers) — and a mistyped type was told to add a name.
  if (type === "mutation") return t.send(mutationRefusedFrame(data)) // mutations go to /api/handlers
  if (type !== "query" && type !== "paginated-query") return t.send(unknownTypeFrame(data))
  if (!name) {
    // For a sid, on the frame type its request would get: a client routes a sid's frames by type.
    // Without one, as before 4.0.0.
    const typed = data.sid !== undefined && data.sid !== null
    const frameType = type === "query" ? "QueryResult" : "PaginatedQueryResult"
    return t.send(withRid({ ...(typed ? { type: frameType } : {}), success: false, error: "Name is required" }, data))
  }
  t.live.handle(t.id, data)
}

/**
 * The answer to a `mutation` message, on both transports.
 *
 * MUTATIONS DO NOT TRAVEL OVER THE SOCKET. `useMutation` has always POSTed to /api/handlers
 * when online and run against the client DB when offline, so this message served no
 * first-party caller — but it ran the full public mutation set under the handshake's
 * session, which made it a second write door nobody instruments.
 *
 * That is what broke: an app wrapping its HTTP routes to record WHO is acting (an audit
 * trail, a request id, a tenant stamp) covers the door it knows about, and writes arriving
 * here carry none of it. The authorization is identical — the same requireUser, the same
 * handler — so nothing looks wrong; the write is simply unattributed. A door that cannot be
 * instrumented from outside the library is better closed than documented.
 *
 * Refused rather than removed, so a caller relying on it gets an error naming the fix instead
 * of a silent no-op.
 */
export function mutationRefusedFrame(msg: unknown): Record<string, unknown> {
  return withRid(
    {
      type: "MutationResult",
      success: false,
      error: "[mogobase] Mutations are not accepted over the WebSocket — POST them to /api/handlers, which is what useMutation does.",
    },
    msg
  )
}

/** The answer to a message of a type the transport does not know, on both transports. */
export function unknownTypeFrame(msg: any): Record<string, unknown> {
  return withRid({ success: false, error: `Unknown type: ${msg?.type}` }, msg)
}
