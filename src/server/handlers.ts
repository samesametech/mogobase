import z4 from "zod/v4"

import DB from "@/db"
import type { MogobaseDB } from "@/db"
import { ChangeStreamOptions, Document } from "mongodb"

export type Context = {
  db?: MogobaseDB
  runQuery?: (name: string, args: any, ctx?: Context) => Promise<any>
  runMutation?: (name: string, args: any, ctx?: Context) => Promise<any>
  watch?: (modelName: string, pipeline?: Document[], options?: ChangeStreamOptions) => void
  headers?: any
}

export type QueryHandler = {
  args: z4.ZodType
  handler: (
    args: any,
    ctx: {
      headers?: any
      db: MogobaseDB
      runQuery: (name: string, args: any, ctx?: Context) => Promise<any>
      runMutation: (name: string, args: any, ctx?: Context) => Promise<any>
      watch: (modelName: string, pipeline?: Document[], options?: ChangeStreamOptions) => void
    }
  ) => Promise<any>
}

export type MutationHandler = {
  args: z4.ZodType
  handler: (
    args: any,
    ctx: {
      headers?: any
      db: MogobaseDB
      runQuery: (name: string, args: any, ctx?: Context) => Promise<any>
      runMutation: (name: string, args: any, ctx?: Context) => Promise<any>
    }
  ) => Promise<any>
}

class Handlers {
  static _instance: Handlers
  queries: Map<string, QueryHandler> = new Map()
  mutations: Map<string, MutationHandler> = new Map()
  _queries: Map<string, QueryHandler> = new Map()
  _mutations: Map<string, MutationHandler> = new Map()

  constructor() {
    if (!Handlers._instance) {
      Handlers._instance = this
    }
    return Handlers._instance
  }

  async _runQuery(name: string, args: any, ctx: Context = {}) {
    let handler = this.queries.get(name)
    if (!handler) {
      if (name.startsWith("internal")) {
        handler = this._queries.get(name)
        if (!handler) {
          throw new Error(`Query ${name} not found`)
        }
      } else {
        throw new Error(`Query ${name} not found`)
      }
    }
    const validated = await handler.args.safeParseAsync(args)
    if (validated.success) {
      return await handler.handler(validated.data, {
        headers: ctx.headers || null,
        db: ctx.db || DB,
        runQuery: this._runQuery.bind(this),
        runMutation: this._runMutation.bind(this),
        watch: ctx.watch || (() => {}),
      })
    } else {
      throw new Error(`Invalid args: ${validated.error.issues[0].message}`)
    }
  }

  async _runMutation(name: string, args: any, ctx: Context = {}) {
    let handler = this.mutations.get(name)
    if (!handler) {
      if (name.startsWith("internal")) {
        handler = this._mutations.get(name)
        if (!handler) {
          throw new Error(`Mutation ${name} not found`)
        }
      } else {
        throw new Error(`Mutation ${name} not found`)
      }
    }
    const validated = await handler.args.safeParseAsync(args)
    if (validated.success) {
      return await handler.handler(validated.data, {
        headers: ctx.headers || null,
        db: ctx.db || DB,
        runQuery: this._runQuery.bind(this),
        runMutation: this._runMutation.bind(this),
      })
    } else {
      throw new Error(`Invalid args: ${validated.error.issues[0].message}`)
    }
  }
}

// filename: callsite.ts
export function query(name: string, c: QueryHandler) {
  if (Handlers._instance.queries.has(name)) {
    throw new Error(`Handler ${name} already exists`)
  }
  Handlers._instance.queries.set(name, c)
}

export function mutation(name: string, c: MutationHandler) {
  if (Handlers._instance.mutations.has(name)) {
    throw new Error(`Handler ${name} already exists`)
  }
  Handlers._instance.mutations.set(name, c)
}

export function internalQuery(name: string, c: QueryHandler) {
  if (Handlers._instance._queries.has(name)) {
    throw new Error(`Handler ${name} already exists`)
  }
  Handlers._instance._queries.set(`internal.${name}`, c)
}

export function internalMutation(name: string, c: MutationHandler) {
  if (Handlers._instance._mutations.has(name)) {
    throw new Error(`Handler ${name} already exists`)
  }
  Handlers._instance._mutations.set(`internal.${name}`, c)
}

export const v = z4

export default new Handlers()
