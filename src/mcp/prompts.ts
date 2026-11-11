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
5. Before setting any mogobase option (attachMogobaseWebSocket's, defineModel's, the sync engine's), read \`mogobase://guide/configuration\`: it lists every default and how to choose values for this project's shape — propose the few that should differ, with the reason.
6. Always import handler code from \`"mogobase/runtime"\` — never \`"mogobase/server"\`.

Start by calling \`mogobase_check_setup\`.`

const UPGRADE_PROMPT = `I want to upgrade mogobase in this app to the version now installed (or to the latest major).

Follow this workflow:

1. Read the \`mogobase://guide/upgrading\` resource to the end before changing anything. It lists every breaking change, each with a search to find it in this app, the fix, and how to check it.
2. Check the installed version (\`node -p "require('mogobase/package.json').version"\`) and the MongoDB server version (4.0.0 needs 4.2 or newer).
3. Do NOT run \`mogobase_install\` or \`npx mogobase install\` to refresh templates: it overwrites hooks, routes and server.ts that this app may have customised. Apply the guide's edits by hand.
4. For each change in the guide, run its "Find" search. When nothing matches, note that the change does not apply. When something matches, apply its "Fix" and show me the diff.
5. Read \`mogobase://guide/configuration\` and propose the options whose defaults do not fit this app, with the reason for each. Do not change them without asking me.
6. Run the type check and the tests, start the server, and read the log for the warnings the guide lists.
7. Report back:
   - which changes applied, and what you changed for each;
   - which did not apply;
   - any warnings left in the log;
   - the options you propose.`

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "upgrade-mogobase",
    {
      title: "Upgrade mogobase in this project",
      description:
        "Walks the assistant through a major upgrade: read the upgrading guide, find each breaking change in the app, fix it, check the log, propose options.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: UPGRADE_PROMPT },
        },
      ],
    })
  )
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
