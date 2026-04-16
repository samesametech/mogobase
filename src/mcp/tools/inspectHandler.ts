import fs from "fs"
import path from "path"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { parseAllHandlers } from "./parseHandlers.js"

export function registerInspectHandlerTool(server: McpServer) {
  server.registerTool(
    "mogobase_inspect_handler",
    {
      title: "Inspect a mogobase handler",
      description:
        "Returns the source file snippet and parsed metadata for a named handler. The name can be the bare handler name (e.g. 'listTodos') or an internal name (e.g. 'internal.cleanupSessions').",
      inputSchema: {
        name: z.string().describe("Handler name to inspect."),
        cwd: z.string().optional().describe("Project root. Defaults to the MCP process cwd."),
      },
    },
    async ({ name, cwd }) => {
      const target = cwd ?? process.cwd()
      const { handlers } = parseAllHandlers(target)
      // Match by bare name OR by the stored "internal.X" convention
      const found = handlers.find(
        (h) => h.name === name || `internal.${h.name}` === name || h.name === name.replace(/^internal\./, "")
      )
      if (!found) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Handler not found: ${name}`, available: handlers.map((h) => h.name) }, null, 2),
            },
          ],
          isError: true,
        }
      }
      const abs = path.join(target, found.file)
      const lines = fs.readFileSync(abs, "utf8").split("\n")
      // Return ~30 lines of context starting at the handler line
      const start = Math.max(0, found.line - 1)
      const end = Math.min(lines.length, found.line + 30)
      const snippet = lines.slice(start, end).join("\n")
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...found, source: snippet }, null, 2),
          },
        ],
      }
    }
  )
}
