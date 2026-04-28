// Server-side sync engine.
//
// Three exported functions consumed by attachWs.ts, ws.ts, hono.ts, and the
// Next.js /api/sync/route.ts template:
//   - pullChanges: returns docs newer than checkpoint, plus a new checkpoint.
//   - pushChanges: writes a batch of client docs, returns server-side conflicts.
//   - streamChanges: opens MongoDB change streams and notifies on every change.
//
// The wire shape is shared with the client sync engines via src/client/sync-types.ts.
//
// Critical: pull queries DO NOT filter `deletedAt: null`. Sync must propagate
// soft-deletes — the client engines look at `_deleted` to apply tombstones.

import type { ChangeStream } from "mongodb"

import DB from "@/db"
import type { SyncDoc, SyncPushRow } from "@/client/sync-types"

const EPOCH = 0

function parseCheckpoint(checkpoint: number | null): number {
  if (checkpoint == null) return EPOCH
  if (typeof checkpoint === "number" && !isNaN(checkpoint)) return checkpoint
  return EPOCH
}

function pickEffectiveTimestamp(doc: any): number {
  // Retrofit: pre-existing docs without updatedAt fall back to createdAt, then epoch.
  if (typeof doc?.updatedAt === "number") return doc.updatedAt
  if (doc?.updatedAt instanceof Date) return doc.updatedAt.getTime()
  if (doc?.updatedAt) {
    const d = new Date(doc.updatedAt)
    if (!isNaN(d.getTime())) return d.getTime()
  }
  if (typeof doc?.createdAt === "number") return doc.createdAt
  if (doc?.createdAt instanceof Date) return doc.createdAt.getTime()
  if (doc?.createdAt) {
    const d = new Date(doc.createdAt)
    if (!isNaN(d.getTime())) return d.getTime()
  }
  return EPOCH
}

function toMs(d: Date | string | number | null | undefined): number | null {
  if (d == null) return null
  if (typeof d === "number") return isNaN(d) ? null : d
  if (d instanceof Date) return d.getTime()
  const parsed = new Date(d)
  return isNaN(parsed.getTime()) ? null : parsed.getTime()
}

function toSyncDoc(doc: any): SyncDoc {
  const effective = pickEffectiveTimestamp(doc)
  const _id = doc._id != null ? String(doc._id) : ""
  const updatedAt = effective
  const deletedAt = toMs(doc.deletedAt)
  const out: SyncDoc = {
    ...doc,
    _id,
    updatedAt,
    deletedAt,
    _deleted: !!deletedAt,
  }
  if (doc.createdAt != null) (out as any).createdAt = toMs(doc.createdAt) ?? doc.createdAt
  return out
}

export async function pullChanges(args: {
  model: string
  checkpoint: number | null
  batchSize?: number
}): Promise<{ documents: SyncDoc[]; checkpoint: number | null }> {
  const { model, checkpoint } = args
  const batchSize = Math.max(1, Math.min(args.batchSize ?? 200, 1000))

  await DB.connect()
  const collection = DB.model(model)
  const since = parseCheckpoint(checkpoint)

  // Pull anything modified after `since`. We DO NOT filter on deletedAt:null —
  // tombstones must propagate. updatedAt is auto-stamped on every write
  // including soft-deletes (see autoStamp.ts).
  const filter = since === 0
    ? {}
    : {
        $or: [
          { updatedAt: { $gt: since } },
          // Retrofit branch — for docs without updatedAt, fall back to createdAt.
          { updatedAt: { $exists: false }, createdAt: { $gt: since } },
        ],
      }

  const docs = await collection
    .find(filter)
    .sort({ updatedAt: 1, createdAt: 1 })
    .limit(batchSize)
    .toArray()

  const documents = docs.map(toSyncDoc)
  const lastTs = documents.length
    ? documents[documents.length - 1].updatedAt
    : checkpoint

  return { documents, checkpoint: lastTs }
}

export async function pushChanges(args: {
  model: string
  rows: SyncPushRow[]
}): Promise<{ conflicts: SyncDoc[] }> {
  const { model, rows } = args
  await DB.connect()
  const collection = DB.model(model)

  const conflicts: SyncDoc[] = []

  for (const row of rows) {
    const next = row.newDocumentState
    if (!next || typeof next._id !== "string" || !next._id) continue
    const _id = next._id
    const existing = await collection.findOne({ _id: _id as any })

    if (existing) {
      const existingTs = pickEffectiveTimestamp(existing)
      const assumedTs = row.assumedMasterState
        ? pickEffectiveTimestamp(row.assumedMasterState)
        : 0
      if (existingTs > assumedTs) {
        // Server is ahead — return the server's version as a conflict.
        conflicts.push(toSyncDoc(existing))
        continue
      }
    }

    // Apply the client doc. Timestamps are numbers (ms since epoch).
    const now = Date.now()
    const updatedAt = typeof next.updatedAt === "number" ? next.updatedAt : (toMs(next.updatedAt) ?? now)
    const existingCreatedAt = toMs((existing as any)?.createdAt)
    const createdAt = (next as any).createdAt != null
      ? (typeof (next as any).createdAt === "number"
          ? (next as any).createdAt
          : (toMs((next as any).createdAt) ?? now))
      : (existingCreatedAt ?? now)
    // Honor both _deleted (RxDB tombstone) and a directly-set deletedAt (soft-delete via adapter).
    const isTombstone = !!next._deleted || next.deletedAt != null
    const deletedAt = isTombstone
      ? (next.deletedAt != null ? (typeof next.deletedAt === "number" ? next.deletedAt : (toMs(next.deletedAt) ?? now)) : now)
      : null

    const stored: any = { ...next }
    delete stored._deleted
    stored._id = _id
    stored.updatedAt = updatedAt
    stored.createdAt = createdAt
    stored.deletedAt = deletedAt

    if (existing) {
      const { _id: _omit, ...replace } = stored
      await collection.updateOne({ _id: _id as any }, { $set: replace })
    } else {
      await collection.insertOne(stored)
    }
  }

  return { conflicts }
}

export function streamChanges(
  models: string[],
  onEvent: (model: string) => void
): () => void {
  const streams: ChangeStream[] = []
  let cancelled = false

  // We connect lazily so callers don't have to await.
  ;(async () => {
    try {
      await DB.connect()
      if (cancelled) return
      for (const model of models) {
        try {
          const stream = DB.model(model).watch([], { fullDocument: "updateLookup" })
          stream.on("change", () => onEvent(model))
          stream.on("error", (err) => {
            console.warn(`[mogobase/sync] change stream error for ${model}:`, err)
          })
          streams.push(stream)
        } catch (err) {
          console.warn(`[mogobase/sync] failed to open change stream for ${model}:`, err)
        }
      }
    } catch (err) {
      console.warn("[mogobase/sync] streamChanges init failed:", err)
    }
  })()

  return () => {
    cancelled = true
    for (const s of streams) {
      try {
        s.close()
      } catch {}
    }
    streams.length = 0
  }
}
