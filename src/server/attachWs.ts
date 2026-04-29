import type { Server as HttpServer, IncomingMessage } from "http"
import { WebSocketServer, WebSocket } from "ws"
import { randomUUID } from "crypto"
import { ChangeStream, ChangeStreamOptions, Document } from "mongodb"

import handlers from "./handlers"
import DB from "@/db"
import {
  pullChanges,
  pushChanges,
  type SyncPolicy,
  type SyncPolicyDecision,
} from "./sync"
import { createStreamHub, type StreamHub } from "./streamHub"
import { createRefetchScheduler } from "./refetchScheduler"
import { stableStringify } from "./stableStringify"
import type { MongoFilter } from "@/runtime/filterMatcher"

type PaginatedSub = {
  name: string
  baseArgs: any
  headers: IncomingMessage["headers"]
  limit: number
  sortAscending: boolean
  sortCaseInsensitive: boolean
  loadedCount: number
  hasPrevious: boolean
  hasNext: boolean
  nextCursor?: string
  previousCursor?: string
  changeStreams: ChangeStream[]
  queue: Promise<void>
}

type SocketState = {
  ws: WebSocket
  changeStreams?: ChangeStream[]
  paginated?: PaginatedSub
  syncUnsub?: () => void
  hubUnsubs?: (() => Promise<void>)[]
  schedulerKeys?: Set<string>
}

export type AttachMogobaseOptions = {
  syncPolicy?: SyncPolicy
  refetchDebounceMs?: number
}

export function attachMogobaseWebSocket(
  server: HttpServer,
  path: string = "/ws",
  options: AttachMogobaseOptions = {}
) {
  const wss = new WebSocketServer({ noServer: true })
  const state = new Map<string, SocketState>()
  const syncPolicy = options.syncPolicy

  const debounceMs = options.refetchDebounceMs ?? 100
  const scheduler = createRefetchScheduler({ debounceMs })
  const hub: StreamHub = createStreamHub({
    openStream: async (model) => {
      await DB.connect()
      return DB.model(model).watch([], { fullDocument: "updateLookup" }) as any
    },
  })

  async function evaluatePolicy(
    op: "pull" | "push" | "watch",
    model: string,
    headers: IncomingMessage["headers"]
  ): Promise<SyncPolicyDecision> {
    if (!syncPolicy) return { allow: true }
    try {
      return await syncPolicy({ op, model, headers })
    } catch (err) {
      console.warn(`[mogobase/sync] policy threw for ${op} ${model}:`, err)
      return { allow: false }
    }
  }

  const sendJson = (ws: WebSocket, payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
  }

  const closeStreams = async (id: string) => {
    const streams = state.get(id)?.changeStreams || []
    for (const cs of streams) {
      try {
        await cs.close()
      } catch {}
    }
    const current = state.get(id)
    if (current) state.set(id, { ...current, changeStreams: [] })
  }

  const closePaginatedSub = async (id: string) => {
    const streams = state.get(id)?.paginated?.changeStreams || []
    for (const cs of streams) {
      try {
        await cs.close()
      } catch {}
    }
    const current = state.get(id)
    if (current) state.set(id, { ...current, paginated: undefined })
  }

  // Tear down all hub subscriptions and pending scheduler keys for a socket.
  // Used when transitioning between query / paginated-query modes — without
  // this, prior-mode hub subs stay open until socket close.
  const clearWatchers = async (id: string) => {
    const s = state.get(id)
    if (!s) return
    if (s.schedulerKeys) {
      for (const k of s.schedulerKeys) scheduler.cancel(k)
    }
    if (s.hubUnsubs) {
      for (const u of s.hubUnsubs) {
        try { await u() } catch {}
      }
    }
    const refreshed = state.get(id)
    if (refreshed) {
      state.set(id, { ...refreshed, hubUnsubs: [], schedulerKeys: new Set() })
    }
  }

  const bindStreamToWs = (ws: WebSocket, cs: ChangeStream) => {
    const onWsClose = () => {
      cs.close().catch(() => {})
    }
    ws.once("close", onWsClose)
    cs.once("close", () => ws.removeListener("close", onWsClose))
  }

  async function runRefetch(id: string, ws: WebSocket, sub: PaginatedSub) {
    const s = state.get(id)
    if (!s || s.paginated !== sub || ws.readyState !== ws.OPEN) return

    const paginationOpts = {
      limit: sub.loadedCount,
      sortAscending: sub.sortAscending,
      sortCaseInsensitive: sub.sortCaseInsensitive,
    }
    const callArgs = { ...sub.baseArgs, paginationOpts }

    try {
      await DB.connect()
      const rs = await handlers._runQuery(sub.name, callArgs, {
        headers: sub.headers,
        db: DB,
        watch: () => {},
      })
      if (!rs?.results) throw new Error("Invalid paginated result")

      sub.loadedCount = rs.results.length
      sub.hasPrevious = !!rs.hasPrevious
      sub.hasNext = !!rs.hasNext
      sub.nextCursor = rs.hasNext ? rs.next : undefined
      sub.previousCursor = rs.hasPrevious ? rs.previous : undefined

      sendJson(ws, { type: "PaginatedQueryResult", success: true, data: rs })
    } catch (error: any) {
      sendJson(ws, {
        type: "PaginatedQueryResult",
        success: false,
        error: `${error?.message || error}`,
      })
    }
  }

  function scheduleRefetch(id: string, ws: WebSocket, sub: PaginatedSub) {
    sub.queue = sub.queue.then(() => runRefetch(id, ws, sub)).catch(() => {})
  }

  async function runPaginatedInitial(
    id: string,
    ws: WebSocket,
    headers: IncomingMessage["headers"],
    name: string,
    args: any
  ) {
    await closeStreams(id)
    await closePaginatedSub(id)
    await clearWatchers(id)
    await DB.connect()

    const paginationOpts = args?.paginationOpts || {}
    const baseArgs = { ...(args || {}) }
    delete baseArgs.paginationOpts

    const pendingStreams: ChangeStream[] = []
    const hubSpecsForPaginated: { model: string; filter: MongoFilter | undefined }[] = []
    const sub: PaginatedSub = {
      name,
      baseArgs,
      headers,
      limit: paginationOpts.limit ?? 10,
      sortAscending: paginationOpts.sortAscending ?? true,
      sortCaseInsensitive: paginationOpts.sortCaseInsensitive ?? false,
      loadedCount: 0,
      hasPrevious: false,
      hasNext: false,
      changeStreams: [],
      queue: Promise.resolve(),
    }

    try {
      const rs = await handlers._runQuery(name, args, {
        headers,
        db: DB,
        watch: (modelName: string, pipelineOrFilter?: Document[] | Document) => {
          if (ws.readyState !== ws.OPEN) return
          const isLegacyPipeline = Array.isArray(pipelineOrFilter)
          if (isLegacyPipeline) {
            const cs = DB.model(modelName).watch(pipelineOrFilter as Document[], {
              fullDocument: "updateLookup",
            } as ChangeStreamOptions)
            pendingStreams.push(cs)
            return
          }
          const filter = (pipelineOrFilter as MongoFilter | undefined) ?? undefined
          hubSpecsForPaginated.push({ model: modelName, filter })
        },
      })

      if (!rs?.results) {
        throw new Error("Invalid paginated result. Return value must come from MongoPaging.find")
      }

      const existing = state.get(id)
      if (ws.readyState !== ws.OPEN || !existing) {
        for (const cs of pendingStreams) {
          try {
            await cs.close()
          } catch {}
        }
        return
      }

      sub.loadedCount = rs.results.length
      sub.hasPrevious = !!rs.hasPrevious
      sub.hasNext = !!rs.hasNext
      sub.nextCursor = rs.hasNext ? rs.next : undefined
      sub.previousCursor = rs.hasPrevious ? rs.previous : undefined
      sub.changeStreams = pendingStreams

      state.set(id, { ...existing, paginated: sub })

      const paginatedKey = `${id}:paginated:${name}:${stableStringify(baseArgs)}`
      for (const cs of pendingStreams) {
        bindStreamToWs(ws, cs)
        cs.on("change", () => {
          scheduler.schedule(paginatedKey, async () => {
            scheduleRefetch(id, ws, sub)
          })
          const s = state.get(id)
          s?.schedulerKeys?.add(paginatedKey)
        })
      }

      const hubUnsubsForPaginated: (() => Promise<void>)[] = []
      for (const spec of hubSpecsForPaginated) {
        try {
          const unsub = await hub.subscribe(spec.model, spec.filter, () => {
            if (ws.readyState !== ws.OPEN) return
            scheduler.schedule(paginatedKey, async () => {
              scheduleRefetch(id, ws, sub)
            })
            const s = state.get(id)
            s?.schedulerKeys?.add(paginatedKey)
          })
          hubUnsubsForPaginated.push(unsub)
        } catch (err) {
          console.warn(`[mogobase/attachWs] paginated hub.subscribe failed:`, err)
        }
      }
      const cur = state.get(id)
      if (cur) {
        cur.hubUnsubs = (cur.hubUnsubs ?? []).concat(hubUnsubsForPaginated)
        state.set(id, cur)
      }

      sendJson(ws, { type: "PaginatedQueryResult", success: true, data: rs })
    } catch (error: any) {
      for (const cs of pendingStreams) {
        try {
          await cs.close()
        } catch {}
      }
      sendJson(ws, { type: "PaginatedQueryResult", success: false, error: `${error?.message || error}` })
    }
  }

  async function runPaginatedLoadMore(
    id: string,
    ws: WebSocket,
    direction: "next" | "previous"
  ) {
    const s = state.get(id)
    const sub = s?.paginated
    if (!sub) {
      return sendJson(ws, {
        type: "PaginatedQueryPage",
        success: false,
        direction,
        error: "No active paginated subscription",
      })
    }
    const cursor = direction === "next" ? sub.nextCursor : sub.previousCursor
    if (!cursor) {
      return sendJson(ws, {
        type: "PaginatedQueryPage",
        success: true,
        direction,
        data: { results: [], hasPrevious: sub.hasPrevious, hasNext: sub.hasNext },
      })
    }

    const paginationOpts: any = {
      limit: sub.limit,
      sortAscending: sub.sortAscending,
      sortCaseInsensitive: sub.sortCaseInsensitive,
    }
    if (direction === "next") paginationOpts.next = cursor
    else paginationOpts.previous = cursor
    const callArgs = { ...sub.baseArgs, paginationOpts }

    sub.queue = sub.queue
      .then(async () => {
        if (ws.readyState !== ws.OPEN) return
        try {
          await DB.connect()
          const rs = await handlers._runQuery(sub.name, callArgs, {
            headers: sub.headers,
            db: DB,
            watch: () => {},
          })
          if (!rs?.results) throw new Error("Invalid paginated result")
          sub.loadedCount += rs.results.length
          if (direction === "next") {
            sub.hasNext = !!rs.hasNext
            sub.nextCursor = rs.hasNext ? rs.next : undefined
          } else {
            sub.hasPrevious = !!rs.hasPrevious
            sub.previousCursor = rs.hasPrevious ? rs.previous : undefined
          }
          sendJson(ws, { type: "PaginatedQueryPage", success: true, direction, data: rs })
        } catch (error: any) {
          sendJson(ws, {
            type: "PaginatedQueryPage",
            success: false,
            direction,
            error: `${error?.message || error}`,
          })
        }
      })
      .catch(() => {})
  }

  async function handleEvent(raw: string, ws: WebSocket, id: string, headers: IncomingMessage["headers"]) {
    let data: any
    try {
      data = JSON.parse(raw)
    } catch {
      return sendJson(ws, { success: false, error: "Invalid JSON" })
    }
    const { type, name, args } = data

    if (type === "paginated-query-load-next" || type === "paginated-query-load-previous") {
      return runPaginatedLoadMore(
        id,
        ws,
        type === "paginated-query-load-next" ? "next" : "previous"
      )
    }

    if (type === "sync-subscribe") {
      const models: string[] = Array.isArray(data.models) ? data.models : []
      const prev = state.get(id)
      if (prev?.syncUnsub) {
        try { prev.syncUnsub() } catch {}
      }
      const unsubFns: (() => Promise<void>)[] = []
      for (const model of models) {
        const decision = await evaluatePolicy("watch", model, headers)
        if (!decision.allow) continue
        try {
          const unsub = await hub.subscribe(model, decision.filter, () => {
            sendJson(ws, { type: "sync-stream", model })
          })
          unsubFns.push(unsub)
        } catch (err) {
          console.warn(`[mogobase/attachWs] sync hub.subscribe failed for ${model}:`, err)
        }
      }
      const aggregateUnsub = () => {
        for (const u of unsubFns) { u().catch(() => {}) }
      }
      const current = state.get(id)
      if (current) state.set(id, { ...current, syncUnsub: aggregateUnsub })
      else aggregateUnsub()
      return
    }

    if (type === "sync-pull") {
      try {
        const decision = await evaluatePolicy("pull", data.model, headers)
        if (!decision.allow) {
          throw new Error("Forbidden")
        }
        const rs = await pullChanges({
          model: data.model,
          checkpoint: data.checkpoint ?? null,
          batchSize: data.batchSize,
          extraFilter: decision.filter,
        })
        sendJson(ws, {
          type: "SyncPullResult",
          model: data.model,
          documents: rs.documents,
          checkpoint: rs.checkpoint,
        })
      } catch (error: any) {
        sendJson(ws, {
          type: "SyncPullResult",
          model: data.model,
          success: false,
          error: `${error?.message || error}`,
          documents: [],
          checkpoint: data.checkpoint ?? null,
        })
      }
      return
    }

    if (type === "sync-push") {
      try {
        const decision = await evaluatePolicy("push", data.model, headers)
        if (!decision.allow) {
          throw new Error("Forbidden")
        }
        const rs = await pushChanges({
          model: data.model,
          rows: Array.isArray(data.rows) ? data.rows : [],
          transform: decision.transform,
        })
        sendJson(ws, {
          type: "SyncPushResult",
          model: data.model,
          conflicts: rs.conflicts,
        })
      } catch (error: any) {
        sendJson(ws, {
          type: "SyncPushResult",
          model: data.model,
          success: false,
          error: `${error?.message || error}`,
          conflicts: [],
        })
      }
      return
    }

    if (!name) return sendJson(ws, { success: false, error: "Name is required" })

    if (type === "query") {
      await closeStreams(id)
      await clearWatchers(id)

      const queryKey = `${id}:${name}:${stableStringify(args ?? {})}`

      const run = async (noWatch?: boolean) => {
        await DB.connect()
        try {
          const rs = await handlers._runQuery(name, args, {
            headers,
            db: DB,
            watch: (modelName: string, pipelineOrFilter?: Document[] | Document, watchOpts?: any) => {
              if (noWatch) return
              if (ws.readyState !== ws.OPEN) return
              const s = state.get(id)
              if (!s) return

              const isLegacyPipeline = Array.isArray(pipelineOrFilter)
              if (isLegacyPipeline) {
                const changeStream = DB.model(modelName).watch(pipelineOrFilter as Document[], {
                  ...(watchOpts || {}),
                  fullDocument: "updateLookup",
                  fullDocumentBeforeChange: "whenAvailable",
                } as ChangeStreamOptions)
                bindStreamToWs(ws, changeStream)
                const streams: ChangeStream[] = s.changeStreams || []
                streams.push(changeStream)
                state.set(id, { ...s, changeStreams: streams })
                changeStream.on("change", () => {
                  scheduler.schedule(queryKey, async () => { await run(true) })
                  s.schedulerKeys?.add(queryKey)
                })
                return
              }

              const filter = (pipelineOrFilter as MongoFilter | undefined) ?? undefined
              hub
                .subscribe(modelName, filter, () => {
                  if (ws.readyState !== ws.OPEN) return
                  scheduler.schedule(queryKey, async () => { await run(true) })
                  s.schedulerKeys?.add(queryKey)
                })
                .then((unsub) => {
                  const cur = state.get(id)
                  if (!cur || ws.readyState !== ws.OPEN) {
                    unsub().catch(() => {})
                    return
                  }
                  cur.hubUnsubs = cur.hubUnsubs || []
                  cur.hubUnsubs.push(unsub)
                  state.set(id, cur)
                })
                .catch((err) => {
                  console.warn(`[mogobase/attachWs] hub.subscribe failed for ${modelName}:`, err)
                })
            },
          })
          sendJson(ws, { type: "QueryResult", success: true, data: rs })
        } catch (error: any) {
          sendJson(ws, { type: "QueryResult", success: false, error: `${error?.message || error}` })
        }
      }
      run()
    } else if (type === "paginated-query") {
      await runPaginatedInitial(id, ws, headers, name, args)
    } else if (type === "mutation") {
      await DB.connect()
      try {
        const rs = await handlers._runMutation(name, args, { headers, db: DB })
        sendJson(ws, { type: "MutationResult", success: true, data: rs })
      } catch (error: any) {
        sendJson(ws, { type: "MutationResult", success: false, error: `${error?.message || error}` })
      }
    } else {
      sendJson(ws, { success: false, error: `Unknown type: ${type}` })
    }
  }

  wss.on("connection", (ws, req) => {
    const id = randomUUID()
    state.set(id, { ws })
    ws.on("message", (buf) => {
      handleEvent(buf.toString(), ws, id, req.headers)
    })
    ws.on("close", async () => {
      await closeStreams(id)
      await closePaginatedSub(id)
      const s = state.get(id)
      if (s?.syncUnsub) {
        try { s.syncUnsub() } catch {}
      }
      if (s?.hubUnsubs) {
        for (const u of s.hubUnsubs) { try { await u() } catch {} }
      }
      if (s?.schedulerKeys) {
        for (const k of s.schedulerKeys) scheduler.cancel(k)
      }
      state.delete(id)
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

  const stop = async () => {
    // Restore the upgrade-emit shadow so this attach can be released by GC and
    // a subsequent attach (or a different upgrade handler) sees a clean server.
    if (server.emit === patchedEmit) server.emit = origEmit
    scheduler.cancelAll()
    try { await hub.shutdown() } catch {}
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }

  return Object.assign(wss, { stop }) as typeof wss & { stop: () => Promise<void> }
}
