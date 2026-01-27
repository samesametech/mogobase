#!/usr/bin/env node
import { spawn } from "child_process"
import makeCli from "make-cli"

const version = "1.0.0"

makeCli({
  version,
  name: "mogobase",
  usage: "mogobase dev",
  arguments: "[command] [options]",
  options: [],
  action: (command = "dev", options) => {
    if (command === "dev") {
      const child = spawn("npx tsx watch", ["./node_modules/mogobase/lib/dev/start.js"], {
        shell: true,
        stdio: "inherit",
      })
      child.on("exit", (code) => process.exit(code))
    }
  },
})
