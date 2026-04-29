import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

type Guide = { slug: string; title: string; description: string }

const GUIDES: Guide[] = [
  { slug: "overview", title: "Mogobase Overview", description: "What mogobase is and the shape of a Next.js setup." },
  { slug: "setup", title: "Setup", description: "Step-by-step install and wire-up for a Next.js App Router project." },
  { slug: "handlers", title: "Handlers", description: "query, mutation, internalQuery, internalMutation — args, ctx, conventions." },
  { slug: "models", title: "Models & Schemas", description: "defineModel, zod schemas, indexes, ObjectId, DataLoader, buildFilters." },
  { slug: "hooks", title: "React Hooks", description: "useQuery, useMutation, usePaginatedQuery — usage and transport model." },
  { slug: "provider", title: "MogobaseProvider", description: "Wrapping the app, online/offline flag, handlers loader, boot sequence." },
  { slug: "offline-backends", title: "Offline Backends", description: "RxDB vs WatermelonDB — when to pick each, caveats, interface." },
  { slug: "sync", title: "Sync Mode (Local-First)", description: "Enabling sync, wire protocol, updatedAt semantics, conflict resolution, limitations." },
  { slug: "troubleshooting", title: "Troubleshooting", description: "Common errors: WS not connecting, handlers not registering, offline gotchas." },
  { slug: "scaling", title: "Scaling and Performance", description: "Shared change-stream hub, refetch debounce, backpressure, capacity ceilings." },
]

function guidesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Prefer compiled location (lib/mcp/guides) — falls back to src for local dev.
  const candidates = [path.join(here, "guides"), path.resolve(here, "../../src/mcp/guides")]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error(`Could not locate mogobase MCP guides. Tried:\n${candidates.join("\n")}`)
}

function readGuide(slug: string): string {
  const file = path.join(guidesDir(), `${slug}.md`)
  return fs.readFileSync(file, "utf8")
}

export function registerResources(server: McpServer) {
  for (const g of GUIDES) {
    server.registerResource(
      `guide-${g.slug}`,
      `mogobase://guide/${g.slug}`,
      {
        title: g.title,
        description: g.description,
        mimeType: "text/markdown",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: readGuide(g.slug),
          },
        ],
      })
    )
  }
}
