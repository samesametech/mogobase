import type { Server as HttpServer, IncomingMessage } from "http"
import { WebSocketServer, WebSocket } from "ws"
import { randomUUID } from "crypto"

import DB from "@/db"
import type { SyncPolicy } from "./sync"
import { endSync, type SyncSocketState } from "./syncMessages"
import { headerView, type HeaderView } from "./headers"
import { handleMessage } from "./messages"
import { createStreamHub, onChangeOrResync, type StreamHub } from "./streamHub"
import { routeWatchInput } from "./watchInput"
import { openHubStream, openSpecWatch, streamStarted, warnOwnStream, warnUnnarrowed, watchKey } from "./changeStreamWatch"
import { createLiveQueries, DEFAULT_MAX_BUFFERED_BYTES, numberOption, type WatchSpec } from "./liveQuery"
import { defaultFormatError, resolveRequestDb, watchTarget } from "./requestDb"

// The sync fields are syncMessages' own (SyncSocketState), not a copy kept in step by hand.
type SocketState = SyncSocketState & { ws: WebSocket }

export type AttachMogobaseOptions = {
  syncPolicy?: SyncPolicy
  refetchDebounceMs?: number
  /**
   * The longest a burst of changes may hold a live query's re-run back (default 1000 ms). The
   * debounce alone waits for a quiet gap of refetchDebounceMs, so writes arriving faster than
   * that froze every subscriber's updates for the whole burst.
   */
  refetchMaxWaitMs?: number
  /**
   * The most rows a paginated live query re-reads after a change (default 1000, never below its
   * first page). Past it, the re-run answers with the first `maxRerunRows` rows and
   * `hasNext: true`: the client's list shrinks to the cap and loadNext continues from there. A
   * client that had scrolled further sees its list jump back. `Infinity` restores re-reading
   * the whole loaded window, whose cost — ceil(rows / 300) handler calls and one frame of every
   * row, per matching change — grows with how far a client scrolls.
   */
  maxRerunRows?: number
  /**
   * Backpressure: while a socket has more than this many bytes waiting to be sent (its
   * `bufferedAmount`), its change-triggered re-runs are held — no handler run, no frame — and
   * one runs once the buffer drains. Default 1 MiB. A client reading slower than its frames
   * arrive used to have them pile up in the server until the heartbeat dropped it.
   */
  maxBufferedBytes?: number
  /**
   * The most live subscriptions one socket may hold at once (default 32): its default one
   * (messages without `sid`) and one per client-chosen `sid`. A new one past it is refused with
   * an error frame carrying its sid and `ended: true`. A watch the shared stream cannot run holds
   * a change stream — a pooled connection — per subscription, so this bounds what one tab can
   * take of `maxPoolSize`. See the protocol and configuration guides.
   */
  maxSubscriptionsPerSocket?: number
  /**
   * The most handler runs of one socket's subscriptions in flight at once (default 4): a tab
   * with many subscriptions cannot take the whole database pool. A subscription's own runs are
   * always one at a time; a slow one does not hold up its siblings.
   */
  maxConcurrentRunsPerSocket?: number
  /**
   * How long one run may hold one of those turns (default 5000 ms) before giving it up — the run
   * goes on, outside the cap — so a handler that never settles cannot stop the rest of the tab.
   */
  turnTimeoutMs?: number
  // Interval for protocol-level ping frames to every client. Keeps sockets
  // alive through idle-timeout proxies (Cloudflare drops a WebSocket after
  // 100 s of silence) and reaps dead ones: a client that misses a whole
  // interval without a pong is terminated, which frees its change streams
  // and hub subscriptions. 0 disables. Default 30 000.
  heartbeatMs?: number
  // Sanitizes every error before it is sent to a WS client. Handler errors
  // otherwise reach the browser verbatim — the same leak the HTTP transport
  // guards against. Provide an allowlist-style formatter (log the raw error
  // server-side, return a generic message for anything off-contract) in
  // production. Defaults to the raw message for backward compatibility.
  formatError?: (error: unknown) => string
  // Which database a model's change stream opens on. Default: the one the query read (the
  // resolved request database, see resolveRequestDb). Return another name for a
  // collection that lives in ONE database whatever the request resolves to — identity,
  // reference tables — or the stream listens to an empty copy there and the subscription
  // answers correctly once and never re-runs. null / undefined keeps the default.
  watchDatabaseFor?: (model: string, activeDbName: string) => string | null | undefined
  // Filter the shared change streams in MongoDB instead of in this process. Default false:
  // each (database, model) gets ONE unfiltered stream with every change's full document, and
  // each subscriber's filter is matched here. True: the stream's $match is the OR of the live
  // subscribers' filters, so a change none of them matches is never sent to this process,
  // and the full document is looked up only when a subscriber filters on it. The stream
  // reopens (from a resume token) when the set of subscriber filters changes, so it suits
  // many writes to rows few subscribers watch more than a fast-changing subscriber set.
  serverSideWatchFilters?: boolean
}

export function attachMogobaseWebSocket(server: HttpServer, path: string = "/ws", options: AttachMogobaseOptions = {}) {
  const wss = new WebSocketServer({ noServer: true })
  const state = new Map<string, SocketState>()
  const syncPolicy = options.syncPolicy
  const formatError = options.formatError ?? defaultFormatError

  const debounceMs = options.refetchDebounceMs ?? 100
  // Checked (numberOption): NaN — an unset environment variable — turned backpressure off.
  const maxBufferedBytes = numberOption("maxBufferedBytes", options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES, 0)

  // Checked: NaN turned the heartbeat off without a word (0 still does, on purpose).
  const heartbeatMs = numberOption("heartbeatMs", options.heartbeatMs, 30_000, 0, false)
  // Any frame resets a proxy's idle clock, so pings keep quiet sockets open;
  // and a socket that misses a whole interval without a pong is dead half-open
  // TCP — terminate() fires 'close', which runs the normal cleanup.
  const alive = new WeakSet<WebSocket>()
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const ws of wss.clients) {
            if (!alive.has(ws)) {
              ws.terminate()
              continue
            }
            alive.delete(ws)
            if (ws.readyState === ws.OPEN) ws.ping()
          }
        }, heartbeatMs)
      : undefined
  heartbeat?.unref?.()
  const hub: StreamHub = createStreamHub({
    serverSideFilters: options.serverSideWatchFilters === true,
    whenReady: (stream) => streamStarted(stream as any),
    openStream: openHubStream,
  })

  // THE database this socket's request resolves to (resolveRequestDb) — run once per run (each
  // first run, change-triggered re-run and page load calls the resolver: a resolver that reads a
  // session store is called that often), and used for BOTH the handler and the change streams it
  // opens. Resolving
  // separately in two places is how they drift: with a per-request resolver
  // (DB.setRequestResolver) the handler would read the tenant's database while the watch
  // listened to the default one, so the query returned correct rows exactly once and then never
  // updated again. Nothing throws, and a screen that has simply stopped refreshing looks like a
  // slow network.
  // The exceptions to "watch what you read" (see watchTarget): the watch's own `dbName`, a
  // collection the app says lives elsewhere (watchDatabaseFor), a model's one declared home.

  const sendJson = (ws: WebSocket, payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
  }

  // How one ctx.watch() call is watched: a $match-only filter joins the shared hub stream for
  // its (database, model); a pipeline with other stages gets a change stream of its own. The
  // key is what a re-run's watch is compared by — equal watches are the open one, kept.
  // `ignoreFields` is part of the key: the same filter ignoring other fields is another watch.
  const watchSpec = (model: string, pipelineOrFilter: any, watchOptions: any, active: typeof DB): WatchSpec => {
    const { dbName, db, driverOptions, ignoreFields } = watchTarget(model, watchOptions, active, options.watchDatabaseFor)
    // The shared hub, or a change stream of its own for what its matcher cannot run (routeWatchInput).
    const normalized = routeWatchInput(pipelineOrFilter)
    if (normalized.kind === "pipeline") {
      warnOwnStream(dbName, model, normalized.reason, "live-query watch")
      return {
        key: watchKey({ kind: "stream", dbName, model, filter: normalized.pipeline, driverOptions, ignoreFields }),
        kind: "pipeline",
        model,
        db: db(),
        pipeline: normalized.pipeline,
        options: driverOptions,
        ignoreFields,
      }
    }
    if (normalized.unnarrowed) warnUnnarrowed(dbName, model, normalized.unnarrowed, "live-query watch")
    return {
      key: watchKey({ kind: "hub", dbName, model, filter: normalized.matchFilter, ignoreFields }),
      kind: "hub",
      model,
      dbName,
      filter: normalized.matchFilter,
      ignoreFields,
    }
  }

  const live = createLiveQueries({
    debounceMs,
    maxRerunRows: options.maxRerunRows,
    maxWaitMs: options.refetchMaxWaitMs,
    maxSubscriptionsPerSocket: options.maxSubscriptionsPerSocket,
    maxConcurrentRunsPerSocket: options.maxConcurrentRunsPerSocket,
    turnTimeoutMs: options.turnTimeoutMs,
    formatError,
    resolveActive: resolveRequestDb,
    watchSpec,
    openWatch: async (spec, onEvent, onDead) => {
      if (spec.kind === "hub") {
        // A change or a "resync" re-runs it; an "error" does not end it: the hub keeps
        // reconnecting on its own backoff and resyncs every subscriber once back. Taken as the
        // watch's death, the engine unsubscribed and resubscribed at once — for the slot's last
        // subscriber a new slot with its failure count reset — so the backoff never built up.
        const unsubscribe = await hub.subscribe(spec.dbName, spec.model, spec.filter, onChangeOrResync(onEvent), {
          ignoreFields: spec.ignoreFields,
        })
        return { close: unsubscribe }
      }
      return openSpecWatch(spec, onEvent, onDead, "attachWs")
    },
  })

  // The routing is the protocol's, shared with ws.ts (messages.ts); this is the socket wiring.
  async function handleEvent(raw: string, ws: WebSocket, id: string, headers: HeaderView) {
    if (stopped) return // its socket is closing (see stop)
    return handleMessage(raw, {
      id,
      headers,
      send: (payload) => sendJson(ws, payload),
      live,
      syncState: () => state.get(id),
      syncPolicy,
      syncHub: hub,
      formatError,
      label: "attachWs",
    })
  }

  wss.on("connection", (ws, req) => {
    const id = randomUUID()
    state.set(id, { ws })
    // Node's headers plus the Fetch methods (headerView), built once for the socket: handlers'
    // ctx.headers.get(name) works here as over HTTP and ws.ts; the plain keys are unchanged.
    const headers = headerView(req.headers) as HeaderView
    live.open(id, {
      headers,
      isOpen: () => ws.readyState === ws.OPEN,
      send: (payload) => sendJson(ws, payload),
      isBackedUp: () => ws.bufferedAmount > maxBufferedBytes,
    })
    alive.add(ws)
    ws.on("pong", () => alive.add(ws))
    ws.on("message", (buf) => {
      // Never left to reject unhandled: a resolver or policy that throws here would otherwise
      // take the process down (Node's default for an unhandled rejection).
      handleEvent(buf.toString(), ws, id, headers).catch((err) => console.warn("[mogobase/attachWs] message failed:", err))
    })
    ws.on("close", async () => {
      const s = state.get(id)
      state.delete(id)
      endSync(s)
      await live.close(id)
    })
  })

  // Node.js HTTP server only calls server.emit('upgrade', ...) when at least one
  // 'upgrade' listener is registered. In production (Next.js custom server), the
  // upgrade listener already exists. For standalone HTTP servers (tests, custom
  // setups), we add a no-op listener so the emit-shadow below is reachable.
  if (server.listenerCount("upgrade") === 0) {
    server.on("upgrade", () => {})
  }

  const origEmit = server.emit.bind(server)
  const patchedEmit = function (event: string, ...args: any[]): boolean {
    if (event === "upgrade") {
      const req = args[0] as IncomingMessage
      const socket = args[1]
      const head = args[2]
      try {
        const url = new URL(req.url || "/", "http://localhost")
        if (url.pathname === path) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req)
          })
          return true
        }
      } catch {
        socket.destroy()
        return true
      }
    }
    return origEmit(event, ...args)
  } as typeof server.emit
  server.emit = patchedEmit

  let stopped = false
  const stop = async () => {
    stopped = true
    // Restore the upgrade-emit shadow so this attach can be released by GC and
    // a subsequent attach (or a different upgrade handler) sees a clean server.
    if (server.emit === patchedEmit) server.emit = origEmit
    // Close the clients (1001, going away): wss.close() leaves their sockets open, and a socket
    // left open kept talking to a hub that had shut down — a sync-subscribe opened a stream
    // nothing would ever close, a query got no answer at all. They reconnect to whatever
    // attaches next.
    for (const client of wss.clients) {
      try {
        client.close(1001, "server stopping")
      } catch {}
    }
    if (heartbeat) clearInterval(heartbeat)
    // Sync subscriptions too: wss.close() leaves client sockets open, so their 'close' (which
    // unsubscribes) may never come, and a sync stream of its own would outlive the attach.
    for (const s of state.values()) endSync(s)
    try {
      await live.shutdown()
    } catch {}
    try {
      await hub.shutdown()
    } catch {}
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }

  return Object.assign(wss, { stop }) as typeof wss & { stop: () => Promise<void> }
}
