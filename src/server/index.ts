import { query, mutation, internalQuery, internalMutation, v } from "@/server/handlers"

const PaginationQueryArgs = v.object({
  limit: v.number(),
  paginatedField: v.string().optional(),
  sortAscending: v.boolean().optional(),
  sortCaseInsensitive: v.boolean().optional(),
  previous: v.string().optional(),
  next: v.string().optional(),
})

export { query, mutation, internalQuery, internalMutation, v, PaginationQueryArgs }
