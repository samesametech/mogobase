import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const SETUP_PROMPT = `I want to add mogobase to this Next.js app.

Follow this workflow:

1. Call the \`mogobase_check_setup\` tool to see what's already wired up and what's missing.
2. Read the \`mogobase://guide/overview\` and \`mogobase://guide/setup\` resources so you know the full setup flow.
3. For any missing pieces reported by \`mogobase_check_setup\`:
   - If \`server.ts\`, \`api/handlers/route.ts\`, hooks, or \`./mogobase/\` are missing, propose running the \`mogobase_install\` tool and ask me before running it.
   - Add or update \`package.json\` scripts (\`dev\`: \`tsx server.ts\`, \`start\`: \`NODE_ENV=production tsx server.ts\`).
   - Add missing env vars (\`MONGO_URI\`, \`MONGO_DB\`) to \`.env.local\` (ask me for values if you don't know them).
   - Create or edit a client component that renders \`<MogobaseProvider>\` and mount it in \`app/layout.tsx\`.
4. If I ask for a handler or model, read the matching guide (\`mogobase://guide/handlers\`, \`mogobase://guide/models\`) before writing code.
5. Always import handler code from \`"mogobase/runtime"\` — never \`"mogobase/server"\`.

Start by calling \`mogobase_check_setup\`.`

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "setup-mogobase",
    {
      title: "Set up mogobase in this Next.js project",
      description:
        "Seeds the assistant with the correct mogobase onboarding workflow: check setup, read guides, propose changes, ask before installing.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: SETUP_PROMPT },
        },
      ],
    })
  )
}
