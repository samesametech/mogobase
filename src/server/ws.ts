// import { upgradeWebSocket } from "hono/cloudflare-workers";
import { createNodeWebSocket, NodeWebSocket } from "@hono/node-ws"
import handlers from "./handlers"
import DB from "@/db"
import { Hono } from "hono"
import { ServerType } from "@hono/node-server"
import { ChangeStream, ChangeStreamOptions } from "mongodb"

class WebSocket {
  static _instance: WebSocket

  _nodeWebSocket?: NodeWebSocket
  _changeStream?: ChangeStream
  _state: Map<string, any> = new Map()

  constructor() {
    if (!WebSocket._instance) {
      WebSocket._instance = this
    }
    return WebSocket._instance
  }

  async _handleEvent(event: any, socket: any, id: string) {
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
      const func = async (noWatch?: boolean) => {
        await DB.connect()
        rs = await handlers._runQuery(name, args, {
          db: DB,
          watch: (modelName: string, pipeline?: Document[], options?: ChangeStreamOptions) => {
            if (noWatch) {
              return
            }
            const state = this._state.get(id)
            const resumeToken = state.changeStream?.resumeToken || undefined
            if (state.changeStream) {
              state.changeStream.close()
            }
            const changeStream = DB.model(modelName).watch(pipeline, {
              ...(options || {}),
              fullDocument: "updateLookup",
              ...(resumeToken
                ? {
                    resumeAfter: resumeToken,
                  }
                : {}),
            })
            this._state.set(id, { ...state, changeStream: changeStream })
            changeStream.on("change", (change) => {
              func(true)
            })
          },
        })
        socket.send(JSON.stringify({ type: "QueryResult", success: true, data: rs }))
      }
      func()
    } else if (type === "paginated-query") {
      const func = async (noWatch?: boolean) => {
        await DB.connect()
        rs = await handlers._runQuery(name, args, {
          db: DB,
          watch: (modelName: string, pipeline?: Document[], options?: ChangeStreamOptions) => {
            if (noWatch) {
              return
            }
            const state = this._state.get(id)
            const resumeToken = state.changeStream?.resumeToken || undefined
            if (state.changeStream) {
              state.changeStream.close()
            }
            const changeStream = DB.model(modelName).watch(pipeline, {
              ...(options || {}),
              fullDocument: "updateLookup",
              ...(resumeToken
                ? {
                    resumeAfter: resumeToken,
                  }
                : {}),
            })
            this._state.set(id, { ...state, changeStream: changeStream })
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
      const id = crypto.randomUUID()
      return {
        onMessage: (event, ws) => {
          const state = this._state.get(id)
          if (!state) {
            this._state.set(id, { ws })
          }
          this._handleEvent(event, ws, id)
        },
        onClose: async () => {
          const state = this._state.get(id)
          if (state && state.changeStream) {
            await state.changeStream.close()
            this._state.delete(id)
          }
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
