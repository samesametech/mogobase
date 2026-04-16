import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerInstallTool } from "./install.js"
import { registerCheckSetupTool } from "./checkSetup.js"
import { registerListHandlersTool } from "./listHandlers.js"
import { registerListModelsTool } from "./listModels.js"
import { registerInspectHandlerTool } from "./inspectHandler.js"

export function registerTools(server: McpServer) {
  registerInstallTool(server)
  registerCheckSetupTool(server)
  registerListHandlersTool(server)
  registerListModelsTool(server)
  registerInspectHandlerTool(server)
}
