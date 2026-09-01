import WebSocket from "ws"

export function createWsClient(url: string, headers?: Record<string, string>) {
  // Headers ride the HANDSHAKE, which is the only place a browser-equivalent client can put
  // them — and the only thing a per-request DB resolver has to key on for a socket.
  const ws = new WebSocket(url, headers ? { headers } : undefined)
  const inbox: any[] = []
  const waiters: ((msg: any) => boolean)[] = []
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString())
    inbox.push(msg)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i](msg)) waiters.splice(i, 1)
    }
  })
  return {
    ws,
    open: () => new Promise<void>((res, rej) => {
      // Guard against the race where the handshake completes between
      // `new WebSocket()` and this listener registration — Node's
      // EventEmitter doesn't replay "open", so a missed listener hangs forever.
      if (ws.readyState === WebSocket.OPEN) return res()
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        return rej(new Error(`ws closed before open: readyState=${ws.readyState}`))
      }
      ws.once("open", () => res())
      ws.once("error", rej)
    }),
    send: (obj: any) => ws.send(JSON.stringify(obj)),
    waitFor: (predicate: (msg: any) => boolean, timeoutMs = 5000) =>
      new Promise<any>((resolve, reject) => {
        const existing = inbox.find(predicate)
        if (existing) return resolve(existing)
        const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs)
        waiters.push((m) => {
          if (predicate(m)) { clearTimeout(t); resolve(m); return true }
          return false
        })
      }),
    close: () => new Promise<void>((res) => {
      ws.once("close", () => res())
      ws.close()
    }),
    inbox,
  }
}
