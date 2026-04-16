import fs from "fs"
import path from "path"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

type RouteHandler = { path: string | null; ok: boolean }
type ProviderInfo = { file: string | null; ok: boolean }

type SetupReport = {
  cwd: string
  projectType: "next-app-router" | "next-pages" | "unknown"
  hasServerTs: boolean
  routeHandler: RouteHandler
  hasMogobaseDir: boolean
  handlerFiles: string[]
  provider: ProviderInfo
  packageJson: {
    hasDevScript: boolean
    hasStartScript: boolean
    hasMogobase: boolean
    hasWs: boolean
  }
  env: { mongoUri: boolean; mongoDb: boolean; dotEnvFiles: string[] }
  issues: string[]
}

function detectProjectType(cwd: string): "next-app-router" | "next-pages" | "unknown" {
  const appDirs = [path.join(cwd, "src", "app"), path.join(cwd, "app")]
  const pagesDirs = [path.join(cwd, "src", "pages"), path.join(cwd, "pages")]
  if (appDirs.some((d) => fs.existsSync(d))) return "next-app-router"
  if (pagesDirs.some((d) => fs.existsSync(d))) return "next-pages"
  return "unknown"
}

function findRouteHandler(cwd: string): RouteHandler {
  const candidates = [
    path.join(cwd, "src", "app", "api", "handlers", "route.ts"),
    path.join(cwd, "app", "api", "handlers", "route.ts"),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const src = fs.readFileSync(c, "utf8")
      const ok = /from\s+"mogobase\/server"/.test(src) && /runQuery|runMutation/.test(src)
      return { path: path.relative(cwd, c), ok }
    }
  }
  return { path: null, ok: false }
}

function listHandlerFiles(cwd: string): string[] {
  const dir = path.join(cwd, "mogobase")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => path.join("mogobase", f))
}

function findProvider(cwd: string): ProviderInfo {
  const roots = [path.join(cwd, "src", "app"), path.join(cwd, "app")].filter((d) =>
    fs.existsSync(d)
  )
  // BFS a shallow distance (up to 3 levels) looking for any .ts/.tsx with <MogobaseProvider>.
  const maxDepth = 3
  for (const root of roots) {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
    while (queue.length) {
      const { dir, depth } = queue.shift()!
      if (depth > maxDepth) continue
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          queue.push({ dir: full, depth: depth + 1 })
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          const src = fs.readFileSync(full, "utf8")
          if (/<MogobaseProvider/.test(src)) {
            const ok = /from\s+"mogobase(\/provider)?"/.test(src)
            return { file: path.relative(cwd, full), ok }
          }
        }
      }
    }
  }
  // Also check project-root providers.tsx or similar
  const topLevel = [
    path.join(cwd, "src", "providers.tsx"),
    path.join(cwd, "providers.tsx"),
    path.join(cwd, "src", "app", "providers.tsx"),
    path.join(cwd, "app", "providers.tsx"),
  ]
  for (const c of topLevel) {
    if (fs.existsSync(c)) {
      const src = fs.readFileSync(c, "utf8")
      if (/<MogobaseProvider/.test(src)) {
        const ok = /from\s+"mogobase(\/provider)?"/.test(src)
        return { file: path.relative(cwd, c), ok }
      }
    }
  }
  return { file: null, ok: false }
}

function readPackageJson(cwd: string) {
  const pkgPath = path.join(cwd, "package.json")
  if (!fs.existsSync(pkgPath)) return null
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  } catch {
    return null
  }
}

function checkEnv(cwd: string) {
  const dotEnvFiles = [".env", ".env.local", ".env.development", ".env.development.local"].filter(
    (f) => fs.existsSync(path.join(cwd, f))
  )
  let mongoUri = false
  let mongoDb = false
  for (const f of dotEnvFiles) {
    const src = fs.readFileSync(path.join(cwd, f), "utf8")
    if (/^MONGO_URI=/m.test(src)) mongoUri = true
    if (/^MONGO_DB=/m.test(src)) mongoDb = true
  }
  return { mongoUri, mongoDb, dotEnvFiles }
}

function computeIssues(report: Omit<SetupReport, "issues">): string[] {
  const issues: string[] = []
  if (report.projectType === "unknown") {
    issues.push("No Next.js `app/` or `pages/` directory found — is this a Next.js project?")
  }
  if (!report.hasServerTs) {
    issues.push("Missing `server.ts` at project root — run `mogobase_install`.")
  }
  if (!report.routeHandler.path) {
    issues.push("Missing `api/handlers/route.ts` — run `mogobase_install`.")
  } else if (!report.routeHandler.ok) {
    issues.push(
      `Route handler at \`${report.routeHandler.path}\` doesn't import from "mogobase/server" — it may have been edited incompatibly.`
    )
  }
  if (!report.hasMogobaseDir) {
    issues.push("Missing `./mogobase/` directory — run `mogobase_install` (creates it).")
  } else if (report.handlerFiles.length === 0) {
    issues.push(
      "`./mogobase/` exists but contains no handler files. Add one that calls `query()` / `mutation()` from `mogobase/runtime`."
    )
  }
  if (!report.provider.file) {
    issues.push(
      "No `<MogobaseProvider>` found in the app tree. Wrap your app in a client component that renders `<MogobaseProvider online={...}>`."
    )
  } else if (!report.provider.ok) {
    issues.push(
      `Provider at \`${report.provider.file}\` doesn't import from "mogobase/provider" — fix the import.`
    )
  }
  if (!report.packageJson.hasDevScript) {
    issues.push(`package.json \`dev\` script should be \`tsx server.ts\`.`)
  }
  if (!report.packageJson.hasStartScript) {
    issues.push(`package.json \`start\` script should be \`NODE_ENV=production tsx server.ts\`.`)
  }
  if (!report.packageJson.hasMogobase) {
    issues.push("`mogobase` is not listed in dependencies — run `yarn add mogobase`.")
  }
  if (!report.packageJson.hasWs) {
    issues.push("`ws` is not listed in dependencies — run `yarn add ws && yarn add -D @types/ws`.")
  }
  if (!report.env.mongoUri || !report.env.mongoDb) {
    issues.push(
      "MONGO_URI or MONGO_DB missing from .env files — add them (defaults are mongodb://localhost:27017 / mogobase)."
    )
  }
  return issues
}

function buildReport(cwd: string): SetupReport {
  const projectType = detectProjectType(cwd)
  const hasServerTs = fs.existsSync(path.join(cwd, "server.ts"))
  const routeHandler = findRouteHandler(cwd)
  const hasMogobaseDir = fs.existsSync(path.join(cwd, "mogobase"))
  const handlerFiles = listHandlerFiles(cwd)
  const provider = findProvider(cwd)
  const pkg = readPackageJson(cwd)
  const devScript: string | undefined = pkg?.scripts?.dev
  const startScript: string | undefined = pkg?.scripts?.start
  const packageJson = {
    hasDevScript: typeof devScript === "string" && devScript.includes("tsx server.ts"),
    hasStartScript: typeof startScript === "string" && startScript.includes("tsx server.ts"),
    hasMogobase: !!(pkg?.dependencies?.mogobase || pkg?.devDependencies?.mogobase),
    hasWs: !!(pkg?.dependencies?.ws || pkg?.devDependencies?.ws),
  }
  const env = checkEnv(cwd)
  const base = { cwd, projectType, hasServerTs, routeHandler, hasMogobaseDir, handlerFiles, provider, packageJson, env }
  return { ...base, issues: computeIssues(base) }
}

export function registerCheckSetupTool(server: McpServer) {
  server.registerTool(
    "mogobase_check_setup",
    {
      title: "Check mogobase setup",
      description:
        "Scans the project directory for mogobase scaffolding: server.ts, API route, provider mount, handler files, package.json scripts, env vars. Returns a structured report with any missing pieces in the `issues` array.",
      inputSchema: {
        cwd: z.string().optional().describe("Project root. Defaults to the MCP process cwd."),
      },
    },
    async ({ cwd }) => {
      const target = cwd ?? process.cwd()
      const report = buildReport(target)
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      }
    }
  )
}
