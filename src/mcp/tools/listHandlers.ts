import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { parseAllHandlers } from "./parseHandlers.js"

export function registerListHandlersTool(server: McpServer) {
  server.registerTool(
    "mogobase_list_handlers",
    {
      title: "List mogobase handlers",
      description:
        "Parses ./mogobase/*.ts and returns all query, mutation, internalQuery, internalMutation registrations with their args schema text, file, and line number.",
      inputSchema: {
        cwd: z.string().optional().describe("Project root. Defaults to the MCP process cwd."),
      },
    },
    async ({ cwd }) => {
      const target = cwd ?? process.cwd()
      const { handlers } = parseAllHandlers(target)
      return {
        content: [{ type: "text", text: JSON.stringify(handlers, null, 2) }],
      }
    }
  )
}
