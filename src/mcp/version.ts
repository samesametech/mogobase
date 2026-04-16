import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

export function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, "../../package.json"),
    path.resolve(here, "../../../package.json"),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const pkg = JSON.parse(fs.readFileSync(c, "utf8"))
      if (pkg.name === "mogobase" && typeof pkg.version === "string") return pkg.version
    }
  }
  return "0.0.0"
}
