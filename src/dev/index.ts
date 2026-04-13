#!/usr/bin/env node
import { spawn } from "child_process"
import makeCli from "make-cli"
import { install } from "./install.js"

const version = "1.0.0"

makeCli({
  version,
  name: "mogobase",
  usage: "mogobase <dev|install>",
  arguments: "[command] [options]",
  options: [],
  action: async (command = "dev", options) => {
    if (command === "dev") {
      const child = spawn("npx tsx watch", ["./node_modules/mogobase/lib/dev/start.js"], {
        shell: true,
        stdio: "inherit",
      })
      child.on("exit", (code) => process.exit(code))
      return
    }
    if (command === "install") {
      try {
        await install()
      } catch (err) {
        console.error(err instanceof Error ? err.message : err)
        process.exit(1)
      }
      return
    }
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  },
})
