import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { registerResources } from "./resources.js"
import { registerTools } from "./tools/index.js"
import { registerPrompts } from "./prompts.js"
import { readPackageVersion } from "./version.js"

export async function startMcpServer() {
  const server = new McpServer(
    { name: "mogobase", version: readPackageVersion() },
    { capabilities: { resources: {}, tools: {}, prompts: {} } }
  )

  registerResources(server)
  registerTools(server)
  registerPrompts(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

startMcpServer().catch((err) => {
  console.error("mogobase mcp failed to start:", err)
  process.exit(1)
})
