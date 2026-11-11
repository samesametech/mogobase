// The MCP server's guides and prompts: what a project's AI agent reads to set mogobase up and to
// upgrade it. Every registered guide must load (a slug without its .md failed only when an agent
// asked for it), and the upgrade prompt must send the agent to the upgrading guide.
import { describe, expect, it } from "vitest"
import { registerResources } from "@/mcp/resources"
import { registerPrompts } from "@/mcp/prompts"

describe("MCP guides and prompts", () => {
  it("every registered guide loads, the upgrading guide among them", async () => {
    const guides: { uri: string; read: (uri: URL) => Promise<any> }[] = []
    registerResources({ registerResource: (_name: string, uri: string, _meta: unknown, read: any) => void guides.push({ uri, read }) } as any)
    expect(guides.map((g) => g.uri)).toContain("mogobase://guide/upgrading")
    for (const guide of guides) {
      const result = await guide.read(new URL(guide.uri))
      expect(result.contents[0].text.length).toBeGreaterThan(100)
    }
  })

  it("the upgrade prompt sends the agent to the upgrading and configuration guides", () => {
    const prompts: { name: string; text: string }[] = []
    registerPrompts({ registerPrompt: (name: string, _meta: unknown, build: any) => void prompts.push({ name, text: build().messages[0].content.text }) } as any)
    const upgrade = prompts.find((p) => p.name === "upgrade-mogobase")
    expect(upgrade?.text).toContain("mogobase://guide/upgrading")
    expect(upgrade?.text).toContain("mogobase://guide/configuration")
    expect(prompts.map((p) => p.name)).toContain("setup-mogobase")
  })
})
