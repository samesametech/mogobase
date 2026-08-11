// Shared WS plumbing for the online hooks. One socket per hook call, kept
// alive by the server heartbeat in attachWs (idle-timeout proxies — Cloudflare
// drops at 100 s of silence — never see a quiet socket), and re-subscribed
// here after any close we didn't initiate: a proxy idle drop, a deploy, a
// network blip. Without the retry, a dropped socket left the hook showing
// stale data forever with only a console.warn to show for it.

export function wsUrl(): string {
  const override = process.env.NEXT_MOGOBASE_URL || process.env.MOGOBASE_URL
  if (override) return override.replace(/^http/, "ws") + "/ws"
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${window.location.host}/ws`
  }
  return "ws://localhost:3000/ws"
}

function safeCloseWS(ws: WebSocket | null | undefined) {
  if (!ws) return
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener("open", () => ws.close(), { once: true })
  } else if (ws.readyState === WebSocket.OPEN) {
    ws.close()
  }
}

const INITIAL_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

export type ResilientWs = {
  readonly socket: WebSocket | null
  close: () => void
}

export function openResilientWs(opts: {
  label: string
  // Built fresh on every (re)connect; the server re-runs the handler on
  // subscribe, so a reconnect doubles as a refetch of anything missed.
  subscribeMsg: () => unknown
  onMessage: (msg: any) => void
}): ResilientWs {
  let ws: WebSocket | null = null
  let closed = false
  let retryMs = INITIAL_RETRY_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  const connect = () => {
    const socket = new WebSocket(wsUrl())
    ws = socket
    socket.addEventListener("open", () => {
      if (closed || ws !== socket) return
      retryMs = INITIAL_RETRY_MS
      socket.send(JSON.stringify(opts.subscribeMsg()))
    })
    socket.addEventListener("message", (event) => {
      if (closed || ws !== socket) return
      opts.onMessage(JSON.parse((event as MessageEvent).data))
    })
    socket.addEventListener("close", (event) => {
      if (closed || ws !== socket) return
      console.warn(`[mogobase] ${opts.label} ws closed (${(event as CloseEvent).code}); reconnecting in ${retryMs}ms`)
      timer = setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
    })
  }
  connect()

  return {
    get socket() {
      return ws
    },
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      safeCloseWS(ws)
    },
  }
}
