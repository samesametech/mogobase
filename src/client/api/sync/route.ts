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
//
// Per-user scoping & security are enforced by the policy block below. The
// client controls every byte of every push, so:
//   - allow checks happen here, with a fresh session per request
//   - filter limits which docs the user can pull (server-side WHERE)
//   - transform rewrites every pushed row (forces userId, etc.)
// See: defineModel(name, schema, { sync: { fields: [...] } }) for the
// field-level allowlist that complements this policy.

import { pullChanges, pushChanges, type SyncPolicy } from "mogobase/server/sync"

export const dynamic = "force-dynamic"

// Replace with your auth integration (better-auth, NextAuth, custom, etc.).
// Returning null/undefined for an unauthenticated request will deny all sync ops.
async function getSession(_headers: Headers): Promise<{ userId: string } | null> {
  return null
}

const syncPolicy: SyncPolicy = async ({ model, headers }) => {
  const session = await getSession(headers as any)
  if (!session) return { allow: false }

  // Tune per-model. Default-deny: every model that should sync goes here.
  if (model === "posts") {
    return {
      allow: true,
      filter: { userId: session.userId },
      transform: (doc, existing) => {
        if (existing && existing.userId !== session.userId) {
          throw new Error("Cannot modify another user's post")
        }
        return { ...doc, userId: session.userId }
      },
    }
  }

  return { allow: false }
}

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
      const decision = await syncPolicy({ op: "pull", model: body.model, headers: request.headers })
      if (!decision.allow) return new Response("Forbidden", { status: 403 })
      const rs = await pullChanges({
        model: body.model,
        checkpoint: body.checkpoint ?? null,
        batchSize: body.batchSize,
        extraFilter: decision.filter,
      })
      return Response.json(rs)
    }
    if (action === "push") {
      const decision = await syncPolicy({ op: "push", model: body.model, headers: request.headers })
      if (!decision.allow) return new Response("Forbidden", { status: 403 })
      const rs = await pushChanges({
        model: body.model,
        rows: body.rows || [],
        transform: decision.transform,
      })
      return Response.json(rs)
    }
    return new Response("Unknown action", { status: 400 })
  } catch (error) {
    return new Response(`${error}`, { status: 400 })
  }
}
