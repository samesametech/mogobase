import type { Server as HttpServer, IncomingMessage } from "http"
import { WebSocketServer, WebSocket } from "ws"
import { randomUUID } from "crypto"
import { ChangeStream, ChangeStreamOptions, Document } from "mongodb"

import handlers from "./handlers"
import DB from "@/db"
import { matchFilter } from "./matchFilter"

type PaginatedSub = {
  name: string
  baseArgs: any
  limit: number
  sortAscending: boolean
  sortCaseInsensitive: boolean
  filter?: Document
  paginatedField: string
  // Map<docIdStr, paginatedFieldValue>
  ids: Map<string, any>
  hasPrevious: boolean
  hasNext: boolean
  nextCursor?: string
  previousCursor?: string
  changeStream?: ChangeStream
}

type SocketState = {
  ws: WebSocket
  changeStreams?: ChangeStream[]
  paginated?: PaginatedSub
}

function keyStr(v: any): string {
  if (v == null) return ""
  if (typeof v === "object" && typeof (v as any).toHexString === "function") {
    return (v as any).toHexString()
  }
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

function cmp(a: any, b: any): number {
  const sa = keyStr(a)
  const sb = keyStr(b)
  if (sa < sb) return -1
  if (sa > sb) return 1
  return 0
}

function windowExtremes(sub: PaginatedSub): { min?: any; max?: any } {
  let min: any, max: any
  for (const k of sub.ids.values()) {
    if (min === undefined || cmp(k, min) < 0) min = k
    if (max === undefined || cmp(k, max) > 0) max = k
  }
  return { min, max }
}

function boundOpenness(sub: PaginatedSub) {
  const asc = sub.sortAscending
  const lowerOpen = asc ? !sub.hasPrevious : !sub.hasNext
  const upperOpen = asc ? !sub.hasNext : !sub.hasPrevious
  return { lowerOpen, upperOpen }
}

function keyInWindow(sub: PaginatedSub, key: any): boolean {
  const { min, max } = windowExtremes(sub)
  const { lowerOpen, upperOpen } = boundOpenness(sub)
  if (min === undefined || max === undefined) {
    return lowerOpen && upperOpen
  }
  const aboveMin = cmp(key, min) >= 0
  const belowMax = cmp(key, max) <= 0
  return (aboveMin || lowerOpen) && (belowMax || upperOpen)
}

export function attachMogobaseWebSocket(server: HttpServer, path: string = "/ws") {
  const wss = new WebSocketServer({ noServer: true })
  const state = new Map<string, SocketState>()

  const sendJson = (ws: WebSocket, payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
  }

  const closeStreams = async (id: string) => {
    const s = state.get(id)
    const streams = s?.changeStreams || []
    for (const cs of streams) {
      try {
        await cs.close()
      } catch {}
    }
    if (s) state.set(id, { ...s, changeStreams: [] })
  }

  const closePaginatedSub = async (id: string) => {
    const s = state.get(id)
    const cs = s?.paginated?.changeStream
    if (cs) {
      try {
        await cs.close()
      } catch {}
    }
    if (s) state.set(id, { ...s, paginated: undefined })
  }

  function handleChange(sub: PaginatedSub, change: any, ws: WebSocket) {
    if (!sub.filter) return
    const op = change.operationType
    const after = (change as any).fullDocument
    const before = (change as any).fullDocumentBeforeChange
    const docKey = (change as any).documentKey
    const docId = docKey?._id
    const docIdStr = keyStr(docId)

    if (op === "insert") {
      if (!after) return
      const key = after[sub.paginatedField]
      if (matchFilter(after, sub.filter) && keyInWindow(sub, key)) {
        sub.ids.set(docIdStr, key)
        sendJson(ws, { type: "AddDoc", success: true, data: after })
      }
      return
    }

    if (op === "update" || op === "replace") {
      const afterKey = after ? after[sub.paginatedField] : undefined
      const beforeKey = before ? before[sub.paginatedField] : undefined
      const afterVisible = after
        ? matchFilter(after, sub.filter) && keyInWindow(sub, afterKey)
        : false
      // Fallback when pre-image unavailable: was it tracked in window?
      const beforeVisible = before
        ? matchFilter(before, sub.filter) && keyInWindow(sub, beforeKey)
        : sub.ids.has(docIdStr)

      if (beforeVisible && afterVisible) {
        sub.ids.set(docIdStr, afterKey)
        sendJson(ws, { type: "UpdateDoc", success: true, data: after })
      } else if (!beforeVisible && afterVisible) {
        sub.ids.set(docIdStr, afterKey)
        sendJson(ws, { type: "AddDoc", success: true, data: after })
      } else if (beforeVisible && !afterVisible) {
        sub.ids.delete(docIdStr)
        sendJson(ws, { type: "RemoveDoc", success: true, data: before ?? { _id: docId } })
      }
      return
    }

    if (op === "delete") {
      if (before) {
        const beforeKey = before[sub.paginatedField]
        const beforeVisible = matchFilter(before, sub.filter) && keyInWindow(sub, beforeKey)
        if (beforeVisible) {
          sub.ids.delete(docIdStr)
          sendJson(ws, { type: "RemoveDoc", success: true, data: before })
        }
      } else if (sub.ids.has(docIdStr)) {
        sub.ids.delete(docIdStr)
        sendJson(ws, { type: "RemoveDoc", success: true, data: { _id: docId } })
      }
    }
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

    const paginationArgs = args?.paginationArgs || {}
    const baseArgs = { ...(args || {}) }
    delete baseArgs.paginationArgs

    const sub: PaginatedSub = {
      name,
      baseArgs,
      limit: paginationArgs.limit ?? 10,
      sortAscending: paginationArgs.sortAscending ?? true,
      sortCaseInsensitive: paginationArgs.sortCaseInsensitive ?? false,
      paginatedField: "_id",
      ids: new Map(),
      hasPrevious: false,
      hasNext: false,
    }

    try {
      const rs = await handlers._runQuery(name, args, {
        headers,
        db: DB,
        watch: (modelName: string, pipelineOrFilter?: Document[] | Document, options?: any) => {
          const isArrayPipeline = Array.isArray(pipelineOrFilter)
          const filter =
            !isArrayPipeline && pipelineOrFilter && typeof pipelineOrFilter === "object"
              ? (pipelineOrFilter as Document)
              : undefined
          sub.filter = filter
          if (options?.paginatedField) sub.paginatedField = options.paginatedField
          if (typeof options?.sortAscending === "boolean") sub.sortAscending = options.sortAscending
          if (sub.changeStream) return
          const cs = DB.model(modelName).watch(undefined, {
            fullDocument: "updateLookup",
            fullDocumentBeforeChange: "whenAvailable",
          } as ChangeStreamOptions)
          sub.changeStream = cs
          cs.on("change", (change) => handleChange(sub, change, ws))
        },
      })

      if (!rs?.results) {
        throw new Error("Invalid paginated result. Return value must come from MongoPaging.find")
      }

      for (const doc of rs.results) {
        sub.ids.set(keyStr(doc._id), doc[sub.paginatedField])
      }
      sub.hasPrevious = !!rs.hasPrevious
      sub.hasNext = !!rs.hasNext
      sub.nextCursor = rs.hasNext ? rs.next : undefined
      sub.previousCursor = rs.hasPrevious ? rs.previous : undefined

      const existing = state.get(id) || { ws }
      state.set(id, { ...existing, paginated: sub })

      sendJson(ws, { type: "PaginatedQueryResult", success: true, data: rs })
    } catch (error: any) {
      sendJson(ws, { type: "PaginatedQueryResult", success: false, error: `${error?.message || error}` })
    }
  }

  async function runPaginatedLoadMore(
    id: string,
    ws: WebSocket,
    headers: IncomingMessage["headers"],
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

    const paginationArgs: any = {
      limit: sub.limit,
      sortAscending: sub.sortAscending,
      sortCaseInsensitive: sub.sortCaseInsensitive,
    }
    if (direction === "next") paginationArgs.next = cursor
    else paginationArgs.previous = cursor
    const callArgs = { ...sub.baseArgs, paginationArgs }

    try {
      await DB.connect()
      const rs = await handlers._runQuery(sub.name, callArgs, {
        headers,
        db: DB,
        watch: () => {},
      })
      if (!rs?.results) throw new Error("Invalid paginated result")
      for (const doc of rs.results) {
        sub.ids.set(keyStr(doc._id), doc[sub.paginatedField])
      }
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
        headers,
        type === "paginated-query-load-next" ? "next" : "previous"
      )
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
              const isArrayPipeline = Array.isArray(pipelineOrFilter)
              const pipeline = isArrayPipeline ? (pipelineOrFilter as Document[]) : undefined
              const s = state.get(id)
              const changeStream = DB.model(modelName).watch(pipeline, {
                ...(options || {}),
                fullDocument: "updateLookup",
                fullDocumentBeforeChange: "whenAvailable",
              } as ChangeStreamOptions)
              const streams: ChangeStream[] = s?.changeStreams || []
              streams.push(changeStream)
              state.set(id, { ...(s || { ws }), changeStreams: streams })
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
      state.delete(id)
    })
  })

  // Intercept `upgrade` via `server.emit` rather than `server.on("upgrade")`.
  // In Next.js custom-server setups, Next attaches its own upgrade listener
  // on first request. Both listeners fire for every upgrade, and Next's
  // handler writes to the already-upgraded socket — corrupting the
  // WebSocket stream and causing the browser to close with code 1006.
  // By hooking `emit`, we can short-circuit upgrades on our path so
  // Next's listener never runs for them.
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
