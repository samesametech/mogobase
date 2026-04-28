// RxDB sync engine. Uses replicateRxCollection from rxdb/plugins/replication.
// Each collection gets its own replication stream over a single shared WS to
// the server. Pull responses are multiplexed by `model` field; we keep a
// per-model rxjs Subject so pending pull handlers can resolve when the
// matching SyncPullResult arrives.
//
// Dynamic imports for rxdb/plugins/replication and rxjs keep these out of the
// base bundle when sync isn't enabled.

import type { RxDatabase } from "rxdb"

import type {
  SyncDoc,
  SyncHandle,
  SyncOptions,
  SyncStatus,
  SyncPullResult,
  SyncPushResult,
} from "@/client/sync-types"

type PendingPull = {
  resolve: (rs: { documents: SyncDoc[]; checkpoint: number | null }) => void
  reject: (err: any) => void
}
type PendingPush = {
  resolve: (rs: { conflicts: SyncDoc[] }) => void
  reject: (err: any) => void
}

function defaultWsUrl(): string {
  if (typeof window === "undefined") {
    return process.env.NEXT_MOGOBASE_URL || process.env.MOGOBASE_URL || "ws://localhost:3000/ws"
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${window.location.host}/ws`
}

export async function startRxSync(db: RxDatabase, options: SyncOptions = {}): Promise<SyncHandle> {
  const { replicateRxCollection } = await import("rxdb/plugins/replication")
  const { Subject } = await import("rxjs")

  const wsUrl = options.wsUrl || defaultWsUrl()
  const batchSize = options.batchSize ?? 200

  const targetModels: string[] =
    options.models && options.models.length > 0
      ? options.models
      : Object.keys(db.collections)

  // Per-model rxjs Subject feeds RxDB's replicate stream — events: object means
  // "fresh batch from server", "RESYNC" means "re-pull from current checkpoint".
  const subjects = new Map<string, any>()
  for (const m of targetModels) subjects.set(m, new Subject())

  const pendingPulls = new Map<string, PendingPull[]>()
  const pendingPushes = new Map<string, PendingPush[]>()

  let status: SyncStatus = "idle"
  const statusSubs = new Set<(s: SyncStatus) => void>()
  const setStatus = (next: SyncStatus) => {
    if (status === next) return
    status = next
    for (const cb of statusSubs) {
      try { cb(status) } catch {}
    }
  }

  let cancelled = false
  let ws: WebSocket | null = null
  let reconnectTimer: any = null
  const replications: any[] = []

  function connectWs() {
    if (cancelled) return
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      console.warn("[mogobase/sync] WebSocket constructor failed:", err)
      setStatus("error")
      scheduleReconnect()
      return
    }

    ws.onopen = async () => {
      setStatus("live")
      let extraHeaders: Record<string, string> | undefined
      try {
        if (options.getAuth) extraHeaders = await options.getAuth()
      } catch (err) {
        console.warn("[mogobase/sync] getAuth failed:", err)
      }
      const sub = { type: "sync-subscribe", models: targetModels, headers: extraHeaders }
      ws?.send(JSON.stringify(sub))
      // Trigger an initial resync so RxDB pulls any data available since the
      // last persisted checkpoint.
      for (const m of targetModels) {
        subjects.get(m)?.next("RESYNC")
      }
    }

    ws.onmessage = (ev) => {
      let msg: any
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data?.toString?.() || "")
      } catch {
        return
      }
      if (!msg || typeof msg !== "object") return

      if (msg.type === "sync-stream") {
        const subj = subjects.get(msg.model)
        if (subj) subj.next("RESYNC")
        return
      }

      if (msg.type === "SyncPullResult") {
        const r = msg as SyncPullResult & { error?: string }
        const queue = pendingPulls.get(r.model)
        const next = queue?.shift()
        if (!next) return
        if ((msg as any).success === false || (msg as any).error) {
          next.reject(new Error((msg as any).error || "sync-pull failed"))
        } else {
          next.resolve({ documents: r.documents || [], checkpoint: r.checkpoint ?? null })
        }
        return
      }

      if (msg.type === "SyncPushResult") {
        const r = msg as SyncPushResult & { error?: string }
        const queue = pendingPushes.get(r.model)
        const next = queue?.shift()
        if (!next) return
        if ((msg as any).success === false || (msg as any).error) {
          next.reject(new Error((msg as any).error || "sync-push failed"))
        } else {
          next.resolve({ conflicts: r.conflicts || [] })
        }
        return
      }
    }

    ws.onclose = () => {
      ws = null
      // Drop pending — replication retries will re-issue them.
      for (const queue of pendingPulls.values()) {
        for (const p of queue) p.reject(new Error("WebSocket closed"))
        queue.length = 0
      }
      for (const queue of pendingPushes.values()) {
        for (const p of queue) p.reject(new Error("WebSocket closed"))
        queue.length = 0
      }
      // Trigger RxDB to resync once connection is restored.
      for (const m of targetModels) {
        subjects.get(m)?.next("RESYNC")
      }
      setStatus("error")
      scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose follows; status flip happens there.
    }
  }

  function scheduleReconnect() {
    if (cancelled) return
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectWs()
    }, 3000)
  }

  function sendOrThrow(payload: any): boolean {
    if (!ws || ws.readyState !== 1) return false
    ws.send(JSON.stringify(payload))
    return true
  }

  function awaitPull(model: string): Promise<{ documents: SyncDoc[]; checkpoint: number | null }> {
    return new Promise((resolve, reject) => {
      const q = pendingPulls.get(model) || []
      q.push({ resolve, reject })
      pendingPulls.set(model, q)
    })
  }

  function awaitPush(model: string): Promise<{ conflicts: SyncDoc[] }> {
    return new Promise((resolve, reject) => {
      const q = pendingPushes.get(model) || []
      q.push({ resolve, reject })
      pendingPushes.set(model, q)
    })
  }

  // Set up replication per collection.
  for (const model of targetModels) {
    const collection = db.collections[model]
    if (!collection) continue
    const subj = subjects.get(model)

    const replication = replicateRxCollection({
      collection,
      replicationIdentifier: `mogobase-sync-${model}`,
      live: true,
      retryTime: 5000,
      deletedField: "_deleted",
      pull: {
        batchSize,
        stream$: subj.asObservable(),
        async handler(checkpointOrNull: any, batch: number) {
          setStatus("pulling")
          const checkpoint: number | null =
            checkpointOrNull && typeof checkpointOrNull === "object" && "ts" in checkpointOrNull
              ? (typeof checkpointOrNull.ts === "number" ? checkpointOrNull.ts : null)
              : (typeof checkpointOrNull?.updatedAt === "number" ? checkpointOrNull.updatedAt : null)
          const pending = awaitPull(model)
          const sent = sendOrThrow({
            type: "sync-pull",
            model,
            checkpoint,
            batchSize: batch,
          })
          if (!sent) {
            // Drop the queued listener since the WS isn't open.
            const q = pendingPulls.get(model)
            if (q?.length) q.pop()
            return { documents: [], checkpoint: checkpointOrNull }
          }
          const rs = await pending
          setStatus("live")
          return {
            documents: rs.documents as any[],
            checkpoint: rs.checkpoint != null ? { ts: rs.checkpoint, updatedAt: rs.checkpoint } : checkpointOrNull,
          }
        },
      },
      push: {
        batchSize,
        async handler(rows: any[]) {
          setStatus("pushing")
          const pending = awaitPush(model)
          const sent = sendOrThrow({
            type: "sync-push",
            model,
            rows: rows.map((r) => ({
              assumedMasterState: r.assumedMasterState ?? null,
              newDocumentState: r.newDocumentState,
            })),
          })
          if (!sent) {
            const q = pendingPushes.get(model)
            if (q?.length) q.pop()
            return [] // RxDB retries on next live tick
          }
          const rs = await pending
          setStatus("live")
          // RxDB conflict resolution path.
          if (options.conflictResolver) {
            return rs.conflicts.map((c) => {
              const local = rows.find((r) => r.newDocumentState?._id === c._id)?.newDocumentState
              if (!local) return c
              return options.conflictResolver!(model, local as SyncDoc, c)
            })
          }
          return rs.conflicts as any[]
        },
      },
    })

    replications.push(replication)
  }

  connectWs()

  const handle: SyncHandle = {
    get status() {
      return status
    },
    async cancel() {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      try { ws?.close() } catch {}
      ws = null
      for (const r of replications) {
        try { await r.cancel() } catch {}
      }
      replications.length = 0
      for (const subj of subjects.values()) {
        try { subj.complete() } catch {}
      }
      subjects.clear()
      setStatus("idle")
    },
    onStatusChange(cb) {
      statusSubs.add(cb)
      return () => statusSubs.delete(cb)
    },
  } as SyncHandle

  return handle
}
