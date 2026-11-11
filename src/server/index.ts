import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  runQuery,
  runMutation,
  runInternalQuery,
  runInternalMutation,
  v,
} from "@/server/handlers"
import type { ArgsIssue, InvalidArgsError } from "@/server/handlers"
import { attachMogobaseWebSocket, type AttachMogobaseOptions } from "@/server/attachWs"
// Exported because the handler runtime is not the only thing that writes. A
// framework route (a webhook receiver, a file proxy, an inbound-API logger)
// holds the DB singleton directly, and that handle is unwrapped — so its writes
// carry no createdAt/updatedAt/deletedAt and nothing reports it. Wrap it once at
// the top of such a route and it stamps like a handler's.
import { wrapDbWithAutoStamp } from "@/server/autoStamp"
import { headerView, type HeaderView } from "@/server/headers"
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
  runInternalQuery,
  runInternalMutation,
  attachMogobaseWebSocket,
  wrapDbWithAutoStamp,
  headerView,
  v,
  PaginationQueryArgs,
}
export type {
  HeaderView,
  AttachMogobaseOptions,
  ArgsIssue,
  InvalidArgsError,
  SyncOperation,
  SyncPolicy,
  SyncPolicyContext,
  SyncPolicyDecision,
  SyncPushTransform,
  SyncPullOptions,
  SyncPushOptions,
  SyncStreamSpec,
}
