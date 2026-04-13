import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "out",
  "coverage",
])

function findFolders(root: string, name: string): string[] {
  const matches: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length) {
    const { dir, depth } = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.name === name) matches.push(full)
      queue.push({ dir: full, depth: depth + 1 })
    }
  }
  matches.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))
  return matches
}

function resolveMogobaseRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, "../.."), path.resolve(here, "../../..")]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "src/client/hooks"))) return c
  }
  throw new Error(`Could not locate mogobase package root. Tried:\n${candidates.join("\n")}`)
}

class Installer {
  cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  async copy(src: string, dest: string) {
    const existed = fs.existsSync(dest)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    console.log(`  ${existed ? "update" : "write "}  ${path.relative(this.cwd, dest)}`)
  }
}

function resolveHooksTarget(cwd: string): string {
  const found = findFolders(cwd, "hooks")
  if (found.length > 0) {
    console.log(`[hooks] Installing into ${path.relative(cwd, found[0]) || "."}`)
    return found[0]
  }
  const target = path.join(cwd, "hooks")
  fs.mkdirSync(target, { recursive: true })
  console.log(`[hooks] No existing hooks folder found. Created ${path.relative(cwd, target)}`)
  return target
}

function resolveAppApiTarget(cwd: string): string {
  const candidates = [path.join(cwd, "src", "app"), path.join(cwd, "app")]
  const existing = candidates.find((c) => fs.existsSync(c))
  const base = existing || path.join(cwd, "app")
  const target = path.join(base, "api", "handlers")
  fs.mkdirSync(target, { recursive: true })
  console.log(`[api route] Installing into ${path.relative(cwd, target)}`)
  return target
}

export async function install() {
  const cwd = process.cwd()
  const root = resolveMogobaseRoot()

  const hooksSrc = path.join(root, "src/client/hooks")
  const apiSrc = path.join(root, "src/client/api/handlers")
  const serverTpl = path.join(root, "src/client/server.ts")

  const installer = new Installer(cwd)

  // 1) Hooks
  const hooksTarget = resolveHooksTarget(cwd)
  const hookFiles = fs.readdirSync(hooksSrc).filter((f) => fs.statSync(path.join(hooksSrc, f)).isFile())
  for (const f of hookFiles) {
    await installer.copy(path.join(hooksSrc, f), path.join(hooksTarget, f))
  }

  // 2) Next.js API route
  const apiTarget = resolveAppApiTarget(cwd)
  const apiFiles = fs.readdirSync(apiSrc).filter((f) => fs.statSync(path.join(apiSrc, f)).isFile())
  for (const f of apiFiles) {
    await installer.copy(path.join(apiSrc, f), path.join(apiTarget, f))
  }

  // 3) Custom server at project root
  console.log(`[server] Installing server.ts at project root`)
  await installer.copy(serverTpl, path.join(cwd, "server.ts"))

  // 4) Ensure ./mogobase/ folder exists for handler files
  const handlersDir = path.join(cwd, "mogobase")
  if (!fs.existsSync(handlersDir)) {
    fs.mkdirSync(handlersDir, { recursive: true })
    console.log(`[handlers] Created ./mogobase/ for your query/mutation files`)
  }

  console.log("")
  console.log("Next steps:")
  console.log("  1. yarn add ws @types/ws   (peer deps for the custom server)")
  console.log(`  2. Update package.json scripts:`)
  console.log(`       "dev":   "tsx server.ts"`)
  console.log(`       "build": "next build"`)
  console.log(`       "start": "NODE_ENV=production tsx server.ts"`)
  console.log(`  3. Add handler files to ./mogobase/ (e.g. ./mogobase/tasks.ts)`)
  console.log(`  4. Set MONGO_URI / MONGO_DB in .env.local`)
  console.log("")
  console.log("Done.")
}
