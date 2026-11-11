// import { upgradeWebSocket } from "hono/cloudflare-workers";
import { createNodeWebSocket, NodeWebSocket } from "@hono/node-ws"
import { defaultFormatError, resolveRequestDb, watchTarget } from "./requestDb"
import { headerView } from "./headers"
import { syncHub, type SyncPolicy } from "./sync"
import { endSync } from "./syncMessages"
import { handleMessage } from "./messages"
import { Hono } from "hono"
import { ServerType } from "@hono/node-server"
import { pipelineOf, routeWatchInput } from "./watchInput"
import { createLiveQueries, DEFAULT_MAX_BUFFERED_BYTES, numberOption, type LiveQueries, type LiveQueryOptions } from "./liveQuery"
import { openSpecWatch, warnUnnarrowed, watchKey } from "./changeStreamWatch"

// The live-query options the legacy transport lets an app set (setLiveQueryOptions), by
// attachMogobaseWebSocket's names: one list, so an option added here is passed on without another
// hand-written line. maxRerunRows and maxBufferedBytes were dropped unsaid; refetchMaxWaitMs is
// refused (said so): this transport re-runs at once, with no debounce for it to bound.
const LIVE_OPTION_KEYS = [
  "maxSubscriptionsPerSocket",
  "maxConcurrentRunsPerSocket",
  "turnTimeoutMs",
  "maxRerunRows",
  "maxBufferedBytes",
] as const

/** What `ws.setLiveQueryOptions` takes: attachMogobaseWebSocket's live-query options, but the debounce's. */
export type LegacyLiveOptions = Pick<LiveQueryOptions, "maxSubscriptionsPerSocket" | "maxConcurrentRunsPerSocket" | "turnTimeoutMs" | "maxRerunRows"> & {
  maxBufferedBytes?: number
}

class WebSocket {
  static _instance: WebSocket

  _nodeWebSocket?: NodeWebSocket
  _state: Map<string, any> = new Map()
  _syncPolicy?: SyncPolicy

  // Queries and paginated queries: the same engine attachWs uses, so both transports
  // re-register watches on every run. Every watch here is a change stream of its own, with
  // the pipeline pushed to MongoDB; there is no shared hub on this legacy path.
  //
  // Built on first use, not as a field initializer: field initializers run on every
  // `new WebSocket()` before the constructor hands back the singleton, so each call built
  // an engine (and its scheduler) only to throw it away.
  _liveEngine?: LiveQueries
  get _live(): LiveQueries {
    return (this._liveEngine ??= this._createLive())
  }

  /** The live-query options (setLiveQueryOptions); the engine's defaults when unset. */
  _liveOptions?: LegacyLiveOptions
  /** The send buffer above which a socket's change-triggered re-runs are held (maxBufferedBytes). */
  _maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES

  /**
   * The live-query options, as attachMogobaseWebSocket takes them: `maxSubscriptionsPerSocket`
   * (default 32), `maxConcurrentRunsPerSocket` (4), `turnTimeoutMs` (5000), `maxRerunRows` (1000)
   * and `maxBufferedBytes` (1 MiB) — not `refetchMaxWaitMs`: re-runs here are not debounced. Every watch on this transport is a
   * change stream of its own, holding a pooled connection, so a socket's subscriptions are its
   * streams. Call it before the server takes connections, as setSyncPolicy.
   */
  setLiveQueryOptions(options: LegacyLiveOptions) {
    if (this._liveEngine) {
      console.warn("[mogobase/ws] setLiveQueryOptions after the first connection is ignored: call it before the server takes connections")
      return
    }
    // The documented fields only (anything else is not passed on, and said so), added to what an
    // earlier call set: replaced, a second call reset the fields it left out.
    const next: Record<string, unknown> = { ...this._liveOptions }
    for (const [key, value] of Object.entries(options ?? {})) {
      if (!(LIVE_OPTION_KEYS as readonly string[]).includes(key)) {
        console.warn(`[mogobase/ws] setLiveQueryOptions: ${key} ignored — the legacy transport takes ${LIVE_OPTION_KEYS.join(", ")}`)
      } else if (value !== undefined) next[key] = value
    }
    this._liveOptions = next
  }

  _createLive(): LiveQueries {
    const { maxBufferedBytes, ...engineOptions } = this._liveOptions ?? {}
    this._maxBufferedBytes = numberOption("maxBufferedBytes", maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES, 0)
    return createLiveQueries({
      ...engineOptions,
      debounceMs: 0,
      formatError: defaultFormatError,
      // ONE resolution for the handler and the change streams it opens. Resolving in two
      // places is how they drift apart: with a per-request resolver the handler reads the
      // tenant's database while the watch listens to the default one, so the query answers
      // correctly once and then never updates. Nothing throws.
      resolveActive: resolveRequestDb,
      watchSpec: (model, pipelineOrFilter, options, active) => {
        const { dbName, db, driverOptions, ignoreFields } = watchTarget(model, options, active)
        // Routed as on attachWs, run by MongoDB: an operator no change stream runs ($where, $text,
        // $near) watches the whole collection — kept, the stream was refused on every attempt and
        // the query never updated.
        const routed = routeWatchInput(pipelineOrFilter)
        if (routed.kind === "hub" && routed.unnarrowed) warnUnnarrowed(dbName, model, routed.unnarrowed, "live-query watch")
        const pipeline = pipelineOf(routed)
        return {
          key: watchKey({ kind: "stream", dbName, model, filter: pipeline, driverOptions, ignoreFields }),
          model,
          db: db(),
          pipeline,
          options: driverOptions,
          ignoreFields,
        }
      },
      openWatch: async (spec, onEvent, onDead) =>
        openSpecWatch(spec, onEvent, onDead, "ws"),
    })
  }

  constructor() {
    if (!WebSocket._instance) {
      WebSocket._instance = this
    }
    return WebSocket._instance
  }

  setSyncPolicy(policy: SyncPolicy | undefined) {
    this._syncPolicy = policy
  }

  // The routing is the protocol's, shared with attachWs (messages.ts); this is the socket wiring.
  async _handleEvent(event: any, socket: any, id: string, headers: any) {
    return handleMessage(String(event.data), {
      id,
      headers,
      send: (payload) => {
        if (socket?.readyState === 1) socket.send(JSON.stringify(payload))
      },
      live: this._live,
      syncState: () => this._state.get(id),
      syncPolicy: this._syncPolicy,
      syncHub: syncHub(),
      formatError: defaultFormatError,
      label: "ws",
    })
  }

  createNodeWebSocket(app: Hono) {
    this._nodeWebSocket = createNodeWebSocket({ app })
  }

  upgradeWebSocket() {
    if (!this._nodeWebSocket) {
      throw new Error("Call createNodeWebSocket() first")
    }
    return this._nodeWebSocket.upgradeWebSocket((c) => {
      // One shape on every transport (headerView): plain keys, as attachWs's, and the Fetch methods.
      const headers = headerView(c.req.raw.headers)
      const id = crypto.randomUUID()
      return {
        onMessage: (event, ws) => {
          const state = this._state.get(id)
          if (!state) {
            this._state.set(id, { ws })
            this._live.open(id, {
              headers,
              isOpen: () => ws.readyState === 1,
              send: (payload) => ws.send(JSON.stringify(payload)),
              // Backpressure, as on attachWs: the underlying socket's unsent bytes.
              isBackedUp: () => ((ws as any).raw?.bufferedAmount ?? 0) > this._maxBufferedBytes,
            })
          }
          // Never left to reject unhandled: a policy that throws here would otherwise take the
          // process down (Node's default for an unhandled rejection).
          this._handleEvent(event, ws, id, headers).catch((err) => console.warn("[mogobase/ws] message failed:", err))
        },
        onClose: async () => {
          const s = this._state.get(id)
          this._state.delete(id)
          endSync(s)
          // Not `_live`: its getter builds the engine, so a socket closing before its first
          // message fixed the limits before setLiveQueryOptions could set them.
          await this._liveEngine?.close(id)
        },
      }
    })
  }

  injectWebSocket(server: ServerType) {
    if (!this._nodeWebSocket) {
      throw new Error("Call createNodeWebSocket() first")
    }
    this._nodeWebSocket.injectWebSocket(server)
  }
}

export default new WebSocket()
