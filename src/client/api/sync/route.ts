// Copy this file into your Next.js App Router project at:
//   app/api/sync/route.ts            (or)
//   src/app/api/sync/route.ts
//
// HTTP fallback transport for mogobase sync mode. The default sync engine on
// the client uses WebSockets (/ws); this route handles environments where
// WebSockets are unavailable, or when an alternative sync transport is needed.
//
// POST /api/sync?action=pull  body: { model, checkpoint?, batchSize? }
// POST /api/sync?action=push  body: { model, rows }

import { pullChanges, pushChanges } from "mogobase/server/sync"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const url = new URL(request.url)
  const action = url.searchParams.get("action")
  let body: any
  try {
    body = await request.json()
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }

  try {
    if (action === "pull") {
      const rs = await pullChanges({
        model: body.model,
        checkpoint: body.checkpoint ?? null,
        batchSize: body.batchSize,
      })
      return Response.json(rs)
    }
    if (action === "push") {
      const rs = await pushChanges({
        model: body.model,
        rows: body.rows || [],
      })
      return Response.json(rs)
    }
    return new Response("Unknown action", { status: 400 })
  } catch (error) {
    return new Response(`${error}`, { status: 400 })
  }
}
