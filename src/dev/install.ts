import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

export type Logger = (line: string) => void

export type InstallSummary = {
  created: string[]
  overwritten: string[]
  skipped: string[]
  nextSteps: string[]
}

export type InstallOptions = {
  cwd?: string
  logger?: Logger
}

export function resolveMogobaseRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, "../.."), path.resolve(here, "../../..")]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "src/client/hooks"))) return c
  }
  throw new Error(`Could not locate mogobase package root. Tried:\n${candidates.join("\n")}`)
}

export function resolveAppApiTarget(cwd: string, log: Logger = () => {}): string {
  const candidates = [path.join(cwd, "src", "app"), path.join(cwd, "app")]
  const existing = candidates.find((c) => fs.existsSync(c))
  const base = existing || path.join(cwd, "app")
  const target = path.join(base, "api", "handlers")
  fs.mkdirSync(target, { recursive: true })
  log(`[api route] Installing into ${path.relative(cwd, target)}`)
  return target
}

export function resolveHooksTarget(cwd: string, log: Logger = () => {}): string {
  const existing = [path.join(cwd, "src", "hooks"), path.join(cwd, "hooks")].find((c) =>
    fs.existsSync(c)
  )
  if (existing) {
    log(`[hooks] Installing into ${path.relative(cwd, existing)}`)
    return existing
  }
  const base = fs.existsSync(path.join(cwd, "src")) ? path.join(cwd, "src") : cwd
  const target = path.join(base, "hooks")
  fs.mkdirSync(target, { recursive: true })
  log(`[hooks] Installing into ${path.relative(cwd, target)}`)
  return target
}

function rewriteHookImports(source: string): string {
  return source
    .replace(/from\s+"\.\.\/provider"/g, 'from "mogobase/provider"')
    .replace(/from\s+"\.\.\/\.\.\/runtime"/g, 'from "mogobase/runtime"')
}

class Installer {
  cwd: string
  log: Logger
  created: string[] = []
  overwritten: string[] = []

  constructor(cwd: string, log: Logger) {
    this.cwd = cwd
    this.log = log
  }

  private record(dest: string, existed: boolean) {
    const rel = path.relative(this.cwd, dest)
    if (existed) this.overwritten.push(rel)
    else this.created.push(rel)
    this.log(`  ${existed ? "update" : "write "}  ${rel}`)
  }

  copy(src: string, dest: string) {
    const existed = fs.existsSync(dest)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    this.record(dest, existed)
  }

  writeHookFile(src: string, dest: string) {
    const existed = fs.existsSync(dest)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const content = rewriteHookImports(fs.readFileSync(src, "utf8"))
    fs.writeFileSync(dest, content)
    this.record(dest, existed)
  }

  writeFile(dest: string, content: string) {
    const existed = fs.existsSync(dest)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
    this.record(dest, existed)
  }
}

export async function install(options: InstallOptions = {}): Promise<InstallSummary> {
  const cwd = options.cwd ?? process.cwd()
  const log = options.logger ?? ((line: string) => console.log(line))
  const root = resolveMogobaseRoot()

  const apiSrc = path.join(root, "src/client/api/handlers")
  const serverTpl = path.join(root, "src/client/server.ts")
  const hooksSrc = path.join(root, "src/client/hooks")

  const installer = new Installer(cwd, log)

  // 1) Hooks — copied as templates so consumers can customize behavior.
  const hooksTarget = resolveHooksTarget(cwd, log)
  const hookFiles = fs.readdirSync(hooksSrc).filter((f) => f.endsWith(".ts"))
  for (const f of hookFiles) {
    installer.writeHookFile(path.join(hooksSrc, f), path.join(hooksTarget, f))
  }
  const barrel = `export { default as useQuery } from "./useQuery"
export { default as useMutation } from "./useMutation"
export { default as usePaginatedQuery } from "./usePaginatedQuery"
`
  installer.writeFile(path.join(hooksTarget, "index.ts"), barrel)

  // 2) Next.js API route
  const apiTarget = resolveAppApiTarget(cwd, log)
  const apiFiles = fs.readdirSync(apiSrc).filter((f) => fs.statSync(path.join(apiSrc, f)).isFile())
  for (const f of apiFiles) {
    installer.copy(path.join(apiSrc, f), path.join(apiTarget, f))
  }

  // 3) Custom server at project root
  log(`[server] Installing server.ts at project root`)
  installer.copy(serverTpl, path.join(cwd, "server.ts"))

  // 4) Ensure ./mogobase/ folder exists for handler files
  const handlersDir = path.join(cwd, "mogobase")
  const handlersDirExisted = fs.existsSync(handlersDir)
  if (!handlersDirExisted) {
    fs.mkdirSync(handlersDir, { recursive: true })
    log(`[handlers] Created ./mogobase/ for your query/mutation files`)
    installer.created.push("mogobase/")
  }

  const nextSteps = [
    "yarn add ws @types/ws   (peer deps for the custom server)",
    `Update package.json scripts: "dev": "tsx server.ts", "build": "next build", "start": "NODE_ENV=production tsx server.ts"`,
    `Add handler files to ./mogobase/ — import from "mogobase/runtime" (isomorphic)`,
    "Set MONGO_URI / MONGO_DB in .env.local",
    `Import hooks from your local copy: import { useQuery, useMutation, usePaginatedQuery } from "@/hooks"`,
    `Online-only: wrap app in <MogobaseProvider online={true} handlers={() => import("@/mogobase")}> from "mogobase/provider" — no offline backend install needed`,
    `Offline mode: install rxdb (or @nozbe/watermelondb), then import the singleton (e.g. import RxClientDB from "mogobase/client-db") and pass it as <MogobaseProvider online={isOnline} clientDB={RxClientDB} handlers={() => import("@/mogobase")}>`,
  ]

  log("")
  log("Next steps:")
  nextSteps.forEach((step, i) => log(`  ${i + 1}. ${step}`))
  log("")
  log("Done.")

  return {
    created: installer.created,
    overwritten: installer.overwritten,
    skipped: [],
    nextSteps,
  }
}
