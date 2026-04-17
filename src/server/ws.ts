// import { upgradeWebSocket } from "hono/cloudflare-workers";
import { createNodeWebSocket, NodeWebSocket } from "@hono/node-ws"
import handlers from "./handlers"
import DB from "@/db"
import { Hono } from "hono"
import { ServerType } from "@hono/node-server"
import { ChangeStream, ChangeStreamOptions, Document } from "mongodb"

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

  async _handleEvent(event: any, socket: any, id: string, headers: any) {
    const data = JSON.parse(event.data)
    const { type, name, args } = data
    if (!name) {
      return socket.send({
        success: false,
        error: "Name is required",
      })
    }
    let rs
    if (type === "query") {
      await this._closeStreams(id)
      const func = async (noWatch?: boolean) => {
        await DB.connect()
        rs = await handlers._runQuery(name, args, {
          headers: headers || null,
          db: DB,
          watch: (modelName: string, pipeline?: Document[], options?: ChangeStreamOptions) => {
            if (noWatch) {
              return
            }
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
      await this._closeStreams(id)
      const func = async (noWatch?: boolean) => {
        await DB.connect()
        rs = await handlers._runQuery(name, args, {
          headers: headers || null,
          db: DB,
          watch: (modelName: string, pipeline?: Document[], options?: ChangeStreamOptions) => {
            if (noWatch) {
              return
            }
            const state = this._state.get(id)
            const changeStream = DB.model(modelName).watch(pipeline, {
              ...(options || {}),
              fullDocument: "updateLookup",
            })
            const streams: ChangeStream[] = state?.changeStreams || []
            streams.push(changeStream)
            this._state.set(id, { ...state, changeStreams: streams })
            changeStream.on("change", (change) => {
              if (change.operationType === "update") {
                const { fullDocument } = change
                socket.send(JSON.stringify({ type: "UpdateDoc", success: true, data: fullDocument }))
              }
              func(true)
            })
          },
        })
        if (!rs.results) {
          throw new Error("Invalid paginated result. Make sure the return value is from MongoPaging.find")
        }
        socket.send(JSON.stringify({ type: "PaginatedQueryResult", success: true, data: rs }))
      }
      func()
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
