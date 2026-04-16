import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { install } from "../../dev/install.js"

export function registerInstallTool(server: McpServer) {
  server.registerTool(
    "mogobase_install",
    {
      title: "Install mogobase scaffolding",
      description:
        "Scaffolds mogobase into the current Next.js project: copies hooks, app/api/handlers/route.ts, server.ts, and creates ./mogobase/. Overwrites existing files unconditionally — call mogobase_check_setup first to understand the current state.",
      inputSchema: {
        cwd: z.string().optional().describe("Project root. Defaults to the MCP process cwd."),
      },
    },
    async ({ cwd }) => {
      const logLines: string[] = []
      const summary = await install({
        cwd,
        logger: (line) => logLines.push(line),
      })
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...summary, log: logLines }, null, 2),
          },
        ],
      }
    }
  )
}
