// import { upgradeWebSocket } from "hono/cloudflare-workers";
import { createNodeWebSocket, NodeWebSocket } from "@hono/node-ws"
import handlers from "./handlers"
import DB from "@/db"
import { Hono } from "hono"
import { ServerType } from "@hono/node-server"
import { ChangeStream, ChangeStreamOptions, Document } from "mongodb"
import { matchFilter } from "./matchFilter"

type PaginatedSub = {
  name: string
  baseArgs: any
  limit: number
  sortAscending: boolean
  sortCaseInsensitive: boolean
  filter?: Document
  paginatedField: string
  ids: Map<string, any>
  hasPrevious: boolean
  hasNext: boolean
  nextCursor?: string
  previousCursor?: string
  changeStream?: ChangeStream
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
  if (min === undefined || max === undefined) return lowerOpen && upperOpen
  const aboveMin = cmp(key, min) >= 0
  const belowMax = cmp(key, max) <= 0
  return (aboveMin || lowerOpen) && (belowMax || upperOpen)
}

class WebSocket {
  static _instance: WebSocket

  _nodeWebSocket?: NodeWebSocket
  _state: Map<string, any> = new Map()

  constructor() {
    if (!WebSocket._instance) {
      WebSocket._instance = this
    }
    return WebSocket._instance
  }

  async _closeStreams(id: string) {
    const state = this._state.get(id)
    const streams: ChangeStream[] = state?.changeStreams || []
    for (const s of streams) {
      try {
        await s.close()
      } catch {}
    }
    if (state) this._state.set(id, { ...state, changeStreams: [] })
  }

  async _closePaginatedSub(id: string) {
    const state = this._state.get(id)
    const cs: ChangeStream | undefined = state?.paginated?.changeStream
    if (cs) {
      try {
        await cs.close()
      } catch {}
    }
    if (state) this._state.set(id, { ...state, paginated: undefined })
  }

  _handleChange(sub: PaginatedSub, change: any, socket: any) {
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
        socket.send(JSON.stringify({ type: "AddDoc", success: true, data: after }))
      }
      return
    }

    if (op === "update" || op === "replace") {
      const afterKey = after ? after[sub.paginatedField] : undefined
      const beforeKey = before ? before[sub.paginatedField] : undefined
      const afterVisible = after
        ? matchFilter(after, sub.filter) && keyInWindow(sub, afterKey)
        : false
      const beforeVisible = before
        ? matchFilter(before, sub.filter) && keyInWindow(sub, beforeKey)
        : sub.ids.has(docIdStr)

      if (beforeVisible && afterVisible) {
        sub.ids.set(docIdStr, afterKey)
        socket.send(JSON.stringify({ type: "UpdateDoc", success: true, data: after }))
      } else if (!beforeVisible && afterVisible) {
        sub.ids.set(docIdStr, afterKey)
        socket.send(JSON.stringify({ type: "AddDoc", success: true, data: after }))
      } else if (beforeVisible && !afterVisible) {
        sub.ids.delete(docIdStr)
        socket.send(
          JSON.stringify({ type: "RemoveDoc", success: true, data: before ?? { _id: docId } })
        )
      }
      return
    }

    if (op === "delete") {
      if (before) {
        const beforeKey = before[sub.paginatedField]
        const beforeVisible = matchFilter(before, sub.filter) && keyInWindow(sub, beforeKey)
        if (beforeVisible) {
          sub.ids.delete(docIdStr)
          socket.send(JSON.stringify({ type: "RemoveDoc", success: true, data: before }))
        }
      } else if (sub.ids.has(docIdStr)) {
        sub.ids.delete(docIdStr)
        socket.send(JSON.stringify({ type: "RemoveDoc", success: true, data: { _id: docId } }))
      }
    }
  }

  async _runPaginatedInitial(socket: any, id: string, headers: any, name: string, args: any) {
    await this._closePaginatedSub(id)
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
        headers: headers || null,
        db: DB,
        watch: (
          modelName: string,
          pipelineOrFilter?: Document[] | Document,
          options?: any
        ) => {
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
          cs.on("change", (change) => this._handleChange(sub, change, socket))
        },
      })
      if (!rs?.results) {
        throw new Error("Invalid paginated result. Make sure the return value is from MongoPaging.find")
      }
      for (const doc of rs.results) {
        sub.ids.set(keyStr(doc._id), doc[sub.paginatedField])
      }
      sub.hasPrevious = !!rs.hasPrevious
      sub.hasNext = !!rs.hasNext
      sub.nextCursor = rs.hasNext ? rs.next : undefined
      sub.previousCursor = rs.hasPrevious ? rs.previous : undefined

      const existing = this._state.get(id) || {}
      this._state.set(id, { ...existing, paginated: sub })

      socket.send(JSON.stringify({ type: "PaginatedQueryResult", success: true, data: rs }))
    } catch (error: any) {
      socket.send(
        JSON.stringify({ type: "PaginatedQueryResult", success: false, error: `${error?.message || error}` })
      )
    }
  }

  async _runPaginatedLoadMore(socket: any, id: string, headers: any, direction: "next" | "previous") {
    const state = this._state.get(id)
    const sub: PaginatedSub | undefined = state?.paginated
    if (!sub) {
      return socket.send(
        JSON.stringify({
          type: "PaginatedQueryPage",
          success: false,
          direction,
          error: "No active paginated subscription",
        })
      )
    }
    const cursor = direction === "next" ? sub.nextCursor : sub.previousCursor
    if (!cursor) {
      return socket.send(
        JSON.stringify({
          type: "PaginatedQueryPage",
          success: true,
          direction,
          data: { results: [], hasPrevious: sub.hasPrevious, hasNext: sub.hasNext },
        })
      )
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
        headers: headers || null,
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
      socket.send(JSON.stringify({ type: "PaginatedQueryPage", success: true, direction, data: rs }))
    } catch (error: any) {
      socket.send(
        JSON.stringify({
          type: "PaginatedQueryPage",
          success: false,
          direction,
          error: `${error?.message || error}`,
        })
      )
    }
  }

  async _handleEvent(event: any, socket: any, id: string, headers: any) {
    const data = JSON.parse(event.data)
    const { type, name, args } = data

    if (type === "paginated-query-load-next" || type === "paginated-query-load-previous") {
      return this._runPaginatedLoadMore(
        socket,
        id,
        headers,
        type === "paginated-query-load-next" ? "next" : "previous"
      )
    }

    if (!name) {
      return socket.send(JSON.stringify({ success: false, error: "Name is required" }))
    }

    let rs
    if (type === "query") {
      await this._closeStreams(id)
      const func = async (noWatch?: boolean) => {
        await DB.connect()
        rs = await handlers._runQuery(name, args, {
          headers: headers || null,
          db: DB,
          watch: (
            modelName: string,
            pipelineOrFilter?: Document[] | Document,
            options?: ChangeStreamOptions
          ) => {
            if (noWatch) return
            const isArrayPipeline = Array.isArray(pipelineOrFilter)
            const pipeline = isArrayPipeline ? (pipelineOrFilter as Document[]) : undefined
            const state = this._state.get(id)
            const changeStream = DB.model(modelName).watch(pipeline, {
              ...(options || {}),
              fullDocument: "updateLookup",
            })
            const streams: ChangeStream[] = state?.changeStreams || []
            streams.push(changeStream)
            this._state.set(id, { ...state, changeStreams: streams })
            changeStream.on("change", () => {
              func(true)
            })
          },
        })
        socket.send(JSON.stringify({ type: "QueryResult", success: true, data: rs }))
      }
      func()
    } else if (type === "paginated-query") {
      await this._runPaginatedInitial(socket, id, headers, name, args)
    } else if (type === "mutation") {
      await DB.connect()
      rs = await handlers._runMutation(name, args, {
        headers: headers || null,
        db: DB,
      })
      socket.send(JSON.stringify({ type: "MutationResult", success: true, data: rs }))
    }
  }

  createNodeWebSocket(app: Hono) {
    this._nodeWebSocket = createNodeWebSocket({ app })
  }

  upgradeWebSocket() {
    if (!this._nodeWebSocket) {
      throw new Error("Call createNodeWebSocket() first")
    }
    return this._nodeWebSocket.upgradeWebSocket((c) => {
      const headers = c.req.raw.headers
      const id = crypto.randomUUID()
      return {
        onMessage: (event, ws) => {
          const state = this._state.get(id)
          if (!state) {
            this._state.set(id, { ws })
          }
          this._handleEvent(event, ws, id, headers)
        },
        onClose: async () => {
          await this._closeStreams(id)
          await this._closePaginatedSub(id)
          this._state.delete(id)
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
