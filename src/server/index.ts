import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  runQuery,
  runMutation,
  v,
} from "@/server/handlers"
import { attachMogobaseWebSocket, type AttachMogobaseOptions } from "@/server/attachWs"
import type {
  SyncOperation,
  SyncPolicy,
  SyncPolicyContext,
  SyncPolicyDecision,
  SyncPushTransform,
  SyncPullOptions,
  SyncPushOptions,
  SyncStreamSpec,
} from "@/server/sync"

const PaginationQueryArgs = v.object({
  limit: v.number(),
  paginatedField: v.string().optional(),
  sortAscending: v.boolean().optional(),
  sortCaseInsensitive: v.boolean().optional(),
  previous: v.string().optional(),
  next: v.string().optional(),
})

export {
  query,
  mutation,
  internalQuery,
  internalMutation,
  runQuery,
  runMutation,
  attachMogobaseWebSocket,
  v,
  PaginationQueryArgs,
}
export type {
  AttachMogobaseOptions,
  SyncOperation,
  SyncPolicy,
  SyncPolicyContext,
  SyncPolicyDecision,
  SyncPushTransform,
  SyncPullOptions,
  SyncPushOptions,
  SyncStreamSpec,
}
