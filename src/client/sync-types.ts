// Wire protocol types for mogobase sync mode.
// Browser-safe — no Node imports.

export type SyncDoc = {
  _id: string
  updatedAt: number
  deletedAt: number | null
  _deleted: boolean
  [k: string]: any
}

export type SyncSubscribeRequest = {
  type: "sync-subscribe"
  models: string[]
}

export type SyncStreamEvent = {
  type: "sync-stream"
  model: string
}

export type SyncPullRequest = {
  type: "sync-pull"
  model: string
  checkpoint: number | null
  batchSize: number
}

export type SyncPullResult = {
  type: "SyncPullResult"
  model: string
  documents: SyncDoc[]
  checkpoint: number | null
}

export type SyncPushRow = {
  assumedMasterState: SyncDoc | null
  newDocumentState: SyncDoc
}

export type SyncPushRequest = {
  type: "sync-push"
  model: string
  rows: SyncPushRow[]
}

export type SyncPushResult = {
  type: "SyncPushResult"
  model: string
  conflicts: SyncDoc[]
}

export type SyncWireMessage =
  | SyncSubscribeRequest
  | SyncStreamEvent
  | SyncPullRequest
  | SyncPullResult
  | SyncPushRequest
  | SyncPushResult

export type SyncStatus = "idle" | "pulling" | "pushing" | "live" | "error"

export type SyncConflictResolver = (
  model: string,
  local: SyncDoc,
  remote: SyncDoc
) => SyncDoc

export type SyncOptions = {
  wsUrl?: string
  getAuth?: () => Promise<Record<string, string>>
  models?: string[]
  conflictResolver?: SyncConflictResolver
  batchSize?: number
}

export type SyncHandle = {
  status: SyncStatus
  cancel: () => Promise<void>
  onStatusChange: (cb: (s: SyncStatus) => void) => () => void
}
