import type { Server as HttpServer, IncomingMessage } from "http"
import { WebSocketServer, WebSocket } from "ws"
import { randomUUID } from "crypto"
import { ChangeStream, ChangeStreamOptions, Document } from "mongodb"

import handlers from "./handlers"
import DB from "@/db"
import { pullChanges, pushChanges, streamChanges } from "./sync"

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
}

export function attachMogobaseWebSocket(server: HttpServer, path: string = "/ws") {
  const wss = new WebSocketServer({ noServer: true })
  const state = new Map<string, SocketState>()

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
    await closePaginatedSub(id)
    await DB.connect()

    const paginationOpts = args?.paginationOpts || {}
    const baseArgs = { ...(args || {}) }
    delete baseArgs.paginationOpts

    const pendingStreams: ChangeStream[] = []
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
          const pipeline = Array.isArray(pipelineOrFilter) ? (pipelineOrFilter as Document[]) : undefined
          const cs = DB.model(modelName).watch(pipeline, {
            fullDocument: "updateLookup",
          } as ChangeStreamOptions)
          pendingStreams.push(cs)
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

      for (const cs of pendingStreams) {
        bindStreamToWs(ws, cs)
        cs.on("change", () => scheduleRefetch(id, ws, sub))
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
      const unsub = streamChanges(models, (model) => {
        sendJson(ws, { type: "sync-stream", model })
      })
      const current = state.get(id)
      if (current) state.set(id, { ...current, syncUnsub: unsub })
      else unsub()
      return
    }

    if (type === "sync-pull") {
      try {
        const rs = await pullChanges({
          model: data.model,
          checkpoint: data.checkpoint ?? null,
          batchSize: data.batchSize,
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
        const rs = await pushChanges({
          model: data.model,
          rows: Array.isArray(data.rows) ? data.rows : [],
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
      const run = async (noWatch?: boolean) => {
        await DB.connect()
        try {
          const rs = await handlers._runQuery(name, args, {
            headers,
            db: DB,
            watch: (modelName: string, pipelineOrFilter?: Document[] | Document, options?: any) => {
              if (noWatch) return
              if (ws.readyState !== ws.OPEN) return
              const s = state.get(id)
              if (!s) return
              const isArrayPipeline = Array.isArray(pipelineOrFilter)
              const pipeline = isArrayPipeline ? (pipelineOrFilter as Document[]) : undefined
              const changeStream = DB.model(modelName).watch(pipeline, {
                ...(options || {}),
                fullDocument: "updateLookup",
                fullDocumentBeforeChange: "whenAvailable",
              } as ChangeStreamOptions)
              bindStreamToWs(ws, changeStream)
              const streams: ChangeStream[] = s.changeStreams || []
              streams.push(changeStream)
              state.set(id, { ...s, changeStreams: streams })
              changeStream.on("change", () => {
                run(true)
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
      state.delete(id)
    })
  })

  const origEmit = server.emit.bind(server)
  server.emit = function (event: string, ...args: any[]): boolean {
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
  } as any

  return wss
}
