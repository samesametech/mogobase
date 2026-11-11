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

import { evaluateSyncPolicy, pullChanges, pushChanges, type HeaderView, type SyncPolicy } from "mogobase/server/sync"

export const dynamic = "force-dynamic"

// Replace with your auth integration (better-auth, NextAuth, custom, etc.).
// Returning null/undefined for an unauthenticated request will deny all sync ops.
// `headers` is a HeaderView — the same object over HTTP and the WebSocket: read it as
// headers["cookie"] or headers.get("cookie"). It is a real Fetch Headers (a copy), so an auth
// library that wants one (an `instanceof Headers` check, `new Request(url, { headers })`) takes it.
async function getSession(_headers: HeaderView): Promise<{ userId: string } | null> {
  return null
}

const syncPolicy: SyncPolicy = async ({ model, headers }) => {
  const session = await getSession(headers)
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
      // Asked as over the WebSocket (evaluateSyncPolicy): the same headers shape (plain keys and
      // .get()), and a policy that throws is a logged 403, not its error text sent to the client.
      const decision = await evaluateSyncPolicy(syncPolicy, "pull", body.model, request.headers)
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
      const decision = await evaluateSyncPolicy(syncPolicy, "push", body.model, request.headers)
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
