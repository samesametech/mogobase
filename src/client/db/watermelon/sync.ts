// WatermelonDB sync engine. Uses synchronize() from @nozbe/watermelondb/sync.
//
// Wire shape: same /ws as RxDB, multiplexed by `model` field. We open one WS;
// on `sync-stream` events we trigger a debounced runSync(). The synchronize
// helper does a full pull-then-push per cycle for all tables.
//
// Two known limitations:
//   1. synchronize() writes through Watermelon's internal _applyChanges path,
//      so sync-applied writes do NOT fire MogobaseWatermelonDB's BroadcastChannel.
//      Each tab pulls independently — by design.
//   2. Watermelon does a full pull per cycle. For >10K records per model the
//      initial sync is slow. RxDB does not have this limitation.

import type { Database } from "@nozbe/watermelondb"

import type {
  SyncDoc,
  SyncHandle,
  SyncOptions,
  SyncStatus,
} from "@/client/sync-types"

type PullResp = { documents: SyncDoc[]; checkpoint: number | null }
type PushResp = { conflicts: SyncDoc[] }

function defaultWsUrl(): string {
  if (typeof window === "undefined") {
    return process.env.NEXT_MOGOBASE_URL || process.env.MOGOBASE_URL || "ws://localhost:3000/ws"
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${window.location.host}/ws`
}

export async function startWatermelonSync(
  wdb: Database,
  options: SyncOptions = {}
): Promise<SyncHandle> {
  const { synchronize } = await import("@nozbe/watermelondb/sync")

  const wsUrl = options.wsUrl || defaultWsUrl()
  const batchSize = options.batchSize ?? 200

  // Watermelon doesn't expose its own "list of registered tables" surface in a
  // type-safe way, so we rely on the caller-provided list or sniff via the
  // internal collections map.
  const targetModels: string[] =
    options.models && options.models.length > 0
      ? options.models
      : (() => {
          const map = (wdb as any).collections?.map
          if (map && typeof map === "object") return Object.keys(map)
          return []
        })()

  let status: SyncStatus = "idle"
  const statusSubs = new Set<(s: SyncStatus) => void>()
  const setStatus = (next: SyncStatus) => {
    if (status === next) return
    status = next
    for (const cb of statusSubs) {
      try { cb(status) } catch {}
    }
  }

  // Per-model checkpoint cache (numeric ms timestamps). lastPulledAt from
  // synchronize is a single number — but we sync per-model with our own
  // per-model checkpoint, so we ignore lastPulledAt and use this map instead.
  const checkpoints = new Map<string, number | null>()
  for (const m of targetModels) checkpoints.set(m, null)

  let cancelled = false
  let ws: WebSocket | null = null
  let reconnectTimer: any = null
  let runningPromise: Promise<void> | null = null
  let pendingTrigger = false
  // Set true while synchronize() is mid-flight so the local-change observer
  // doesn't loop on the writes it makes via _applyChanges during the pull.
  let inSyncCycle = false
  let localSub: { unsubscribe: () => void } | null = null

  const pullPending = new Map<string, ((rs: PullResp) => void)[]>()
  const pullErrors = new Map<string, ((err: any) => void)[]>()
  const pushPending = new Map<string, ((rs: PushResp) => void)[]>()
  const pushErrors = new Map<string, ((err: any) => void)[]>()

  function awaitPull(model: string): Promise<PullResp> {
    return new Promise((resolve, reject) => {
      const r = pullPending.get(model) || []
      const e = pullErrors.get(model) || []
      r.push(resolve); e.push(reject)
      pullPending.set(model, r); pullErrors.set(model, e)
    })
  }
  function awaitPush(model: string): Promise<PushResp> {
    return new Promise((resolve, reject) => {
      const r = pushPending.get(model) || []
      const e = pushErrors.get(model) || []
      r.push(resolve); e.push(reject)
      pushPending.set(model, r); pushErrors.set(model, e)
    })
  }

  function sendOrFail(payload: any): boolean {
    if (!ws || ws.readyState !== 1) return false
    ws.send(JSON.stringify(payload))
    return true
  }

  async function wsPull(model: string, checkpoint: number | null): Promise<PullResp> {
    const pending = awaitPull(model)
    const sent = sendOrFail({ type: "sync-pull", model, checkpoint, batchSize })
    if (!sent) throw new Error("WebSocket not open")
    return pending
  }
  async function wsPush(
    model: string,
    rows: { assumedMasterState: SyncDoc | null; newDocumentState: SyncDoc }[]
  ): Promise<PushResp> {
    const pending = awaitPush(model)
    const sent = sendOrFail({ type: "sync-push", model, rows })
    if (!sent) throw new Error("WebSocket not open")
    return pending
  }

  async function runSync() {
    if (cancelled) return
    if (runningPromise) {
      pendingTrigger = true
      return runningPromise
    }
    runningPromise = (async () => {
      inSyncCycle = true
      setStatus("pulling")
      try {
        await synchronize({
          database: wdb,
          // We ignore the synchronize lastPulledAt because we use per-model
          // checkpoints for finer granularity.
          pullChanges: async () => {
            const changes: any = {}
            for (const model of targetModels) {
              changes[model] = { created: [], updated: [], deleted: [] }
              let cursor = checkpoints.get(model) ?? null
              // Page until the server returns an empty/unchanging checkpoint.
              for (let i = 0; i < 100; i++) {
                const rs = await wsPull(model, cursor)
                if (!rs.documents.length) {
                  cursor = rs.checkpoint
                  break
                }
                for (const d of rs.documents) {
                  if (d._deleted) {
                    changes[model].deleted.push(d._id)
                  } else {
                    // Watermelon merges create-or-update from `updated`.
                    changes[model].updated.push({
                      id: d._id,
                      data: JSON.stringify(d),
                      deleted_at: d.deletedAt ?? null,
                    })
                  }
                }
                if (rs.checkpoint === cursor) {
                  cursor = rs.checkpoint
                  break
                }
                cursor = rs.checkpoint
                if (rs.documents.length < batchSize) break
              }
              checkpoints.set(model, cursor)
            }
            return { changes, timestamp: Date.now() }
          },
          pushChanges: async ({ changes }: { changes: any; lastPulledAt: number }) => {
            setStatus("pushing")
            for (const model of Object.keys(changes)) {
              if (!targetModels.includes(model)) continue
              const set = changes[model] as {
                created: any[]
                updated: any[]
                deleted: string[]
              }
              const rows: { assumedMasterState: SyncDoc | null; newDocumentState: SyncDoc }[] = []
              const decode = (raw: any) => {
                let blob: any = {}
                try {
                  blob = raw.data ? JSON.parse(raw.data) : raw
                } catch {}
                const _id = raw.id || blob._id
                const updatedAt = typeof blob.updatedAt === "number" ? blob.updatedAt : Date.now()
                const deletedAt = raw.deleted_at ?? blob.deletedAt ?? null
                return {
                  ...blob,
                  _id,
                  updatedAt,
                  deletedAt,
                  _deleted: !!deletedAt,
                } as SyncDoc
              }
              for (const c of set.created) rows.push({ assumedMasterState: null, newDocumentState: decode(c) })
              for (const u of set.updated) rows.push({ assumedMasterState: null, newDocumentState: decode(u) })
              for (const id of set.deleted) {
                const now = Date.now()
                rows.push({
                  assumedMasterState: null,
                  newDocumentState: {
                    _id: id,
                    updatedAt: now,
                    deletedAt: now,
                    _deleted: true,
                  } as SyncDoc,
                })
              }
              if (rows.length === 0) continue
              await wsPush(model, rows)
            }
          },
          conflictResolver: options.conflictResolver
            ? (table: string, local: any, remote: any, _resolved: any) => {
                const pick = options.conflictResolver!(table, local, remote)
                return pick
              }
            : undefined,
          sendCreatedAsUpdated: true,
        } as any)
        setStatus("live")
      } catch (err) {
        console.warn("[mogobase/sync] watermelon synchronize failed:", err)
        setStatus("error")
      } finally {
        inSyncCycle = false
        runningPromise = null
        if (pendingTrigger && !cancelled) {
          pendingTrigger = false
          // Re-trigger after the current cycle.
          runSync().catch(() => {})
        }
      }
    })()
    return runningPromise
  }

  function rejectPending() {
    for (const [model, errs] of pullErrors) {
      for (const e of errs) e(new Error("WebSocket closed"))
      errs.length = 0
      pullPending.get(model)!.length = 0
    }
    for (const [model, errs] of pushErrors) {
      for (const e of errs) e(new Error("WebSocket closed"))
      errs.length = 0
      pushPending.get(model)!.length = 0
    }
  }

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
      ws?.send(
        JSON.stringify({ type: "sync-subscribe", models: targetModels, headers: extraHeaders })
      )
      runSync().catch(() => {})
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
        runSync().catch(() => {})
        return
      }
      if (msg.type === "SyncPullResult") {
        const queue = pullPending.get(msg.model)
        const errs = pullErrors.get(msg.model)
        const next = queue?.shift()
        const nextErr = errs?.shift()
        if (!next) return
        if (msg.success === false || msg.error) {
          nextErr?.(new Error(msg.error || "sync-pull failed"))
        } else {
          next({ documents: msg.documents || [], checkpoint: msg.checkpoint ?? null })
        }
        return
      }
      if (msg.type === "SyncPushResult") {
        const queue = pushPending.get(msg.model)
        const errs = pushErrors.get(msg.model)
        const next = queue?.shift()
        const nextErr = errs?.shift()
        if (!next) return
        if (msg.success === false || msg.error) {
          nextErr?.(new Error(msg.error || "sync-push failed"))
        } else {
          next({ conflicts: msg.conflicts || [] })
        }
        return
      }
    }

    ws.onclose = () => {
      ws = null
      rejectPending()
      setStatus("error")
      scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose follows.
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

  connectWs()

  // Watch for local writes (user mutations) so we trigger a sync push
  // immediately rather than waiting for a server-side change-stream tick.
  // Skip self-fired events from synchronize's pull-apply path via inSyncCycle.
  // Also drop the initial replay value so a fresh subscriber doesn't
  // self-trigger on mount.
  try {
    let primed = false
    localSub = wdb.withChangesForTables(targetModels).subscribe(() => {
      if (!primed) {
        primed = true
        return
      }
      if (cancelled || inSyncCycle) return
      runSync().catch(() => {})
    })
  } catch (err) {
    console.warn("[mogobase/sync] watermelon local change observer failed:", err)
  }

  return {
    get status() {
      return status
    },
    async cancel() {
      cancelled = true
      pendingTrigger = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      try { localSub?.unsubscribe() } catch {}
      localSub = null
      // Reject pending pulls/pushes before closing ws, in case onclose isn't
      // fired synchronously by ws.close() — keeps caller awaits from hanging.
      rejectPending()
      try { ws?.close() } catch {}
      ws = null
      setStatus("idle")
      statusSubs.clear()
    },
    onStatusChange(cb) {
      statusSubs.add(cb)
      return () => statusSubs.delete(cb)
    },
  } as SyncHandle
}
