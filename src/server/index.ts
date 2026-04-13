import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  runQuery,
  runMutation,
  v,
} from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

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
