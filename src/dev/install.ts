import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

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

  const apiSrc = path.join(root, "src/client/api/handlers")
  const serverTpl = path.join(root, "src/client/server.ts")

  const installer = new Installer(cwd)

  // 1) Hooks — imported directly from the "mogobase" package now. Don't copy.
  //    (Older installs may have ./hooks/ templates — they are unused; safe to delete.)

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
  console.log(`  3. Add handler files to ./mogobase/ — import from "mogobase/runtime"`)
  console.log(`       (isomorphic: works on server and in browser for offline mode)`)
  console.log(`  4. Set MONGO_URI / MONGO_DB in .env.local`)
  console.log("")
  console.log("Offline mode (optional):")
  console.log(`  • Wrap your app:`)
  console.log(`      import { MogobaseProvider } from "mogobase/provider"`)
  console.log(`      <MogobaseProvider online={isOnline} handlers={() => import("@/mogobase")}>`)
  console.log(`  • Define models with Zod schemas: defineModel("posts", v.object({...}))`)
  console.log(`  • When online={false}, hooks run against local RxDB (Dexie).`)
  console.log("")
  console.log("Done.")
}
