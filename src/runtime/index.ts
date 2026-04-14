// Browser-safe handler runtime. No mongodb, no ws, no hono imports reachable.
// Consumer handler files (./mogobase/*.ts) should import from here so they
// can run on both server and browser (offline mode).

import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  runQuery,
  runMutation,
  v,
} from "@/server/handlers"

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
  v,
  PaginationQueryArgs,
}
