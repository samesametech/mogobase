// Copy this file into your Next.js App Router project at:
//   app/api/handlers/route.ts          (or)
//   src/app/api/handlers/route.ts
//
// This runs mogobase handlers in-process. Handlers are registered by the
// custom server on boot (see ./server.ts at project root) — do not import
// handler files here.

import { runQuery, runMutation } from "mogobase/server"
import DB from "mogobase/db"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const name = url.searchParams.get("name")
  const argsRaw = url.searchParams.get("args")
  if (!name) return new Response("Name is required", { status: 400 })
  try {
    await DB.connect()
    const rs = await runQuery(name, argsRaw ? JSON.parse(argsRaw) : undefined, {
      db: DB,
      headers: request.headers,
    })
    return Response.json(rs)
  } catch (error) {
    return new Response(`${error}`, { status: 400 })
  }
}

export async function POST(request: Request) {
  const body = await request.json()
  const { name, args } = body
  if (!name) return new Response("Name is required", { status: 400 })
  try {
    await DB.connect()
    const rs = await runMutation(name, args, {
      db: DB,
      headers: request.headers,
    })
    return Response.json(rs)
  } catch (error) {
    return new Response(`${error}`, { status: 400 })
  }
}
