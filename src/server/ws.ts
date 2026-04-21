// import { upgradeWebSocket } from "hono/cloudflare-workers";
import { createNodeWebSocket, NodeWebSocket } from "@hono/node-ws"
import handlers from "./handlers"
import DB from "@/db"
import { Hono } from "hono"
import { ServerType } from "@hono/node-server"
import { ChangeStream, ChangeStreamOptions, Document } from "mongodb"

type PaginatedSub = {
  name: string
  baseArgs: any
  headers: any
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
    const streams: ChangeStream[] = this._state.get(id)?.changeStreams || []
    for (const s of streams) {
      try {
        await s.close()
      } catch {}
    }
    const current = this._state.get(id)
    if (current) this._state.set(id, { ...current, changeStreams: [] })
  }

  async _closePaginatedSub(id: string) {
    const streams: ChangeStream[] = this._state.get(id)?.paginated?.changeStreams || []
    for (const cs of streams) {
      try {
        await cs.close()
      } catch {}
    }
    const current = this._state.get(id)
    if (current) this._state.set(id, { ...current, paginated: undefined })
  }

  _bindStreamToSocket(socket: any, cs: ChangeStream) {
    const raw = socket?.raw
    if (!raw || typeof raw.once !== "function" || typeof raw.removeListener !== "function") return
    const onClose = () => {
      cs.close().catch(() => {})
    }
    raw.once("close", onClose)
    cs.once("close", () => raw.removeListener("close", onClose))
  }

  async _runRefetch(id: string, socket: any, sub: PaginatedSub) {
    const state = this._state.get(id)
    if (!state || state.paginated !== sub) return

    const paginationOpts = {
      limit: sub.loadedCount,
      sortAscending: sub.sortAscending,
      sortCaseInsensitive: sub.sortCaseInsensitive,
    }
    const callArgs = { ...sub.baseArgs, paginationOpts }

    try {
      await DB.connect()
      const rs = await handlers._runQuery(sub.name, callArgs, {
        headers: sub.headers || null,
        db: DB,
        watch: () => {},
      })
      if (!rs?.results) throw new Error("Invalid paginated result")

      sub.loadedCount = rs.results.length
      sub.hasPrevious = !!rs.hasPrevious
      sub.hasNext = !!rs.hasNext
      sub.nextCursor = rs.hasNext ? rs.next : undefined
      sub.previousCursor = rs.hasPrevious ? rs.previous : undefined

      socket.send(JSON.stringify({ type: "PaginatedQueryResult", success: true, data: rs }))
    } catch (error: any) {
      socket.send(
        JSON.stringify({
          type: "PaginatedQueryResult",
          success: false,
          error: `${error?.message || error}`,
        })
      )
    }
  }

  _scheduleRefetch(id: string, socket: any, sub: PaginatedSub) {
    sub.queue = sub.queue.then(() => this._runRefetch(id, socket, sub)).catch(() => {})
  }

  async _runPaginatedInitial(socket: any, id: string, headers: any, name: string, args: any) {
    await this._closePaginatedSub(id)
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
        headers: headers || null,
        db: DB,
        watch: (modelName: string, pipelineOrFilter?: Document[] | Document) => {
          if (socket?.readyState !== 1) return
          const pipeline = Array.isArray(pipelineOrFilter) ? (pipelineOrFilter as Document[]) : undefined
          const cs = DB.model(modelName).watch(pipeline, {
            fullDocument: "updateLookup",
          } as ChangeStreamOptions)
          pendingStreams.push(cs)
        },
      })
      if (!rs?.results) {
        throw new Error("Invalid paginated result. Make sure the return value is from MongoPaging.find")
      }

      const existing = this._state.get(id)
      if (socket?.readyState !== 1 || !existing) {
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

      this._state.set(id, { ...existing, paginated: sub })

      for (const cs of pendingStreams) {
        this._bindStreamToSocket(socket, cs)
        cs.on("change", () => this._scheduleRefetch(id, socket, sub))
      }

      socket.send(JSON.stringify({ type: "PaginatedQueryResult", success: true, data: rs }))
    } catch (error: any) {
      for (const cs of pendingStreams) {
        try {
          await cs.close()
        } catch {}
      }
      socket.send(
        JSON.stringify({
          type: "PaginatedQueryResult",
          success: false,
          error: `${error?.message || error}`,
        })
      )
    }
  }

  async _runPaginatedLoadMore(socket: any, id: string, direction: "next" | "previous") {
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
        try {
          await DB.connect()
          const rs = await handlers._runQuery(sub.name, callArgs, {
            headers: sub.headers || null,
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
      })
      .catch(() => {})
  }

  async _handleEvent(event: any, socket: any, id: string, headers: any) {
    const data = JSON.parse(event.data)
    const { type, name, args } = data

    if (type === "paginated-query-load-next" || type === "paginated-query-load-previous") {
      return this._runPaginatedLoadMore(
        socket,
        id,
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
            if (socket?.readyState !== 1) return
            const state = this._state.get(id)
            if (!state) return
            const isArrayPipeline = Array.isArray(pipelineOrFilter)
            const pipeline = isArrayPipeline ? (pipelineOrFilter as Document[]) : undefined
            const changeStream = DB.model(modelName).watch(pipeline, {
              ...(options || {}),
              fullDocument: "updateLookup",
            })
            this._bindStreamToSocket(socket, changeStream)
            const streams: ChangeStream[] = state.changeStreams || []
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
