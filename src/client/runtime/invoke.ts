// In-browser execution path. Calls the runtime handlers singleton with a
// ctx.db that points at the RxDB-backed MogobaseClientDB adapter.

import { runQuery, runMutation } from "@/runtime"
import type MogobaseClientDB from "@/client/db"

type ClientDB = typeof MogobaseClientDB

export type WatchRecord = { modelName: string }

export async function invokeQuery(
  name: string,
  args: any,
  opts: { db: ClientDB; headers?: any; onWatch?: (w: WatchRecord) => void }
) {
  const watches: WatchRecord[] = []
  const rs = await runQuery(name, args, {
    db: opts.db as any,
    headers: opts.headers,
    watch: (modelName: string) => {
      const w = { modelName }
      watches.push(w)
      opts.onWatch?.(w)
    },
  })
  return { data: rs, watches }
}

export async function invokeMutation(
  name: string,
  args: any,
  opts: { db: ClientDB; headers?: any }
) {
  const rs = await runMutation(name, args, {
    db: opts.db as any,
    headers: opts.headers,
  })
  return rs
}
