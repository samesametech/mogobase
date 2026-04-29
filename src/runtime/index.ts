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
import {
  defineModel,
  getModels,
  getClientFields,
  isSyncEnabled,
  filterClientFields,
  CLIENT_ENGINE_FIELDS,
  onModel,
  type ModelDef,
  type ModelOptions,
} from "./models"
import { isServer, isClient } from "./env"
import { MongoPaging, type PagingParams, type PagingResult } from "./paging"

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
  defineModel,
  getModels,
  getClientFields,
  isSyncEnabled,
  filterClientFields,
  CLIENT_ENGINE_FIELDS,
  onModel,
  isServer,
  isClient,
  MongoPaging,
}
export type { ModelDef, ModelOptions, PagingParams, PagingResult }
