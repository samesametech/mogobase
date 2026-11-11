// A query that a live handler calls through ctx.runQuery registers its watches on the same run
// (review round 15). The nested ctx carried no `watch`, so they were dropped: a write to the
// collection only the nested query watched never re-ran the subscription.
import { describe, expect, it } from "vitest"
import { query, runQuery, v } from "@/server/handlers"

query("r15.listMembers", {
  args: v.object({ org: v.string() }),
  handler: async (args, ctx) => {
    ctx.watch("members", { org: args.org })
    return ["m1"]
  },
})

query("r15.orgPage", {
  args: v.object({ org: v.string() }),
  handler: async (args, ctx) => {
    ctx.watch("orgs", { _id: args.org })
    return { members: await ctx.runQuery("r15.listMembers", { org: args.org }) }
  },
})

describe("ctx.runQuery inside a live query", () => {
  it("the nested query's watches reach the outer run's ctx.watch", async () => {
    const watched: any[] = []
    const fakeDb: any = { model: () => ({}) }
    const rs = await runQuery("r15.orgPage", { org: "o1" }, { db: fakeDb, _resolved: true, watch: (m: string, f?: any) => watched.push([m, f]) } as any)
    expect(rs).toEqual({ members: ["m1"] })
    expect(watched).toEqual([
      ["orgs", { _id: "o1" }],
      ["members", { org: "o1" }],
    ])
  })
})

// What ctx.useDatabase("identity") hands a handler: a db bound to another database.
const identityDb: any = { model: () => ({}), db: { databaseName: "identity" } }

query("r16.identityPage", {
  args: v.object({ org: v.string() }),
  handler: async (args, ctx) => ({
    members: await ctx.runQuery("r15.listMembers", { org: args.org }, { db: identityDb }),
  }),
})

query("r16.explicit", { args: v.object({}), handler: async (_a, ctx) => void ctx.watch("audit", undefined, { dbName: "logs" }) })
query("r16.callsExplicit", { args: v.object({}), handler: async (_a, ctx) => ctx.runQuery("r16.explicit", {}, { db: identityDb }) })
query("r16.sameDb", { args: v.object({}), handler: async (_a, ctx) => ctx.runQuery("r15.listMembers", { org: "o2" }) })
query("r16.ownDbPassed", { args: v.object({}), handler: async (_a, ctx) => ctx.runQuery("r15.listMembers", { org: "o3" }, { db: ctx.db }) })

describe("ctx.runQuery against another database (review round 16)", () => {
  // The caller's watch builds specs on the caller's database: a nested query run with its own
  // `db` (ctx.useDatabase("identity")) watched tenant.members, an empty shadow, and the live
  // query never re-ran on writes to identity.members.
  it("the nested query's watches go to the database it runs against", async () => {
    const watched: any[] = []
    const tenantDb: any = { model: () => ({}), db: { databaseName: "tenant" } }
    await runQuery("r16.identityPage", { org: "o1" }, { db: tenantDb, _resolved: true, watch: (...a: any[]) => watched.push(a) } as any)
    expect(watched).toEqual([["members", { org: "o1" }, { dbName: "identity" }]])
  })

  it("its own explicit dbName still wins", async () => {
    const watched: any[] = []
    await runQuery("r16.callsExplicit", {}, { db: { model: () => ({}) }, _resolved: true, watch: (...a: any[]) => watched.push(a) } as any)
    expect(watched).toEqual([["audit", undefined, { dbName: "logs" }]])
  })

  it("on the caller's own database, its watches are passed on as they are", async () => {
    const watched: any[] = []
    const tenantDb: any = { model: () => ({}), db: { databaseName: "tenant" } }
    await runQuery("r16.sameDb", {}, { db: tenantDb, _resolved: true, watch: (...a: any[]) => watched.push(a) } as any)
    await runQuery("r16.ownDbPassed", {}, { db: tenantDb, _resolved: true, watch: (...a: any[]) => watched.push(a) } as any)
    expect(watched).toEqual([
      ["members", { org: "o2" }],
      ["members", { org: "o3" }], // ctx.db passed back explicitly: no dbName, the model's home still decides
    ])
  })
})
