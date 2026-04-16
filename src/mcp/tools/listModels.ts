import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { parseAllHandlers } from "./parseHandlers.js"

export function registerListModelsTool(server: McpServer) {
  server.registerTool(
    "mogobase_list_models",
    {
      title: "List mogobase models",
      description:
        "Parses ./mogobase/*.ts and returns all defineModel() calls with their schema text, indexes text, file, and line number.",
      inputSchema: {
        cwd: z.string().optional().describe("Project root. Defaults to the MCP process cwd."),
      },
    },
    async ({ cwd }) => {
      const target = cwd ?? process.cwd()
      const { models } = parseAllHandlers(target)
      return {
        content: [{ type: "text", text: JSON.stringify(models, null, 2) }],
      }
    }
  )
}
