import type { Server as HttpServer, IncomingMessage } from "http"
import { WebSocketServer, WebSocket } from "ws"
import { randomUUID } from "crypto"
import { ChangeStream, ChangeStreamOptions, Document } from "mongodb"

import handlers from "./handlers"
import DB from "@/db"

type SocketState = {
  ws: WebSocket
  changeStreams?: ChangeStream[]
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

  async function handleEvent(raw: string, ws: WebSocket, id: string, headers: IncomingMessage["headers"]) {
    let data: any
    try {
      data = JSON.parse(raw)
    } catch {
      return sendJson(ws, { success: false, error: "Invalid JSON" })
    }
    const { type, name, args } = data
    if (!name) return sendJson(ws, { success: false, error: "Name is required" })

    if (type === "query" || type === "paginated-query") {
      const resultType = type === "query" ? "QueryResult" : "PaginatedQueryResult"
      await closeStreams(id)
      const run = async (noWatch?: boolean) => {
        await DB.connect()
        try {
          const rs = await handlers._runQuery(name, args, {
            headers,
            db: DB,
            watch: (modelName: string, pipeline?: Document[], options?: ChangeStreamOptions) => {
              if (noWatch) return
              const s = state.get(id)
              const changeStream = DB.model(modelName).watch(pipeline, {
                ...(options || {}),
                fullDocument: "updateLookup",
              })
              const streams: ChangeStream[] = s?.changeStreams || []
              streams.push(changeStream)
              state.set(id, { ...(s || { ws }), changeStreams: streams })
              changeStream.on("change", (change) => {
                if (type === "paginated-query" && change.operationType === "update") {
                  sendJson(ws, { type: "UpdateDoc", success: true, data: (change as any).fullDocument })
                }
                run(true)
              })
            },
          })
          if (type === "paginated-query" && !rs?.results) {
            throw new Error("Invalid paginated result. Return value must come from MongoPaging.find")
          }
          sendJson(ws, { type: resultType, success: true, data: rs })
        } catch (error: any) {
          sendJson(ws, { type: resultType, success: false, error: `${error?.message || error}` })
        }
      }
      run()
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
      state.delete(id)
    })
  })

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "/", "http://localhost")
      if (url.pathname !== path) return
      wss.handleUpgrade(req, socket as any, head, (ws) => {
        wss.emit("connection", ws, req)
      })
    } catch {
      socket.destroy()
    }
  })

  return wss
}
