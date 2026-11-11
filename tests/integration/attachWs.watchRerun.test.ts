// Watches are re-registered on EVERY run, not frozen at the first.
//
// Re-runs used to pass `noWatch`, so the watches of the first successful run were the
// subscription's forever. A handler that built a watch filter from data it read — here, a
// `$in` of the team's member ids — kept watching the first answer's members: a post by a
// member who joined later never woke the subscription.
//
// Now each successful run's watches are diffed against the open ones: new ones open, dropped
// ones close, and an unchanged one stays open (no stream churn on an ordinary re-run).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import http from "http"
import { AddressInfo } from "net"
import { type ChangeStream, Collection } from "mongodb"
import MongoPagingUpstream from "mongo-cursor-pagination"
import { cleanCollections, connectTestMongo, getTestMongoUri } from "../helpers/mongo"
import { createWsClient } from "../helpers/wsClient"
import DB from "@/db"
import { defineModel } from "@/runtime/models"
import { query, v } from "@/server/handlers"
import { attachMogobaseWebSocket } from "@/server/attachWs"

const MEMBERS = "team_members_rw"
const POSTS = "team_posts_rw"
let server: http.Server
let port: number

// Every change stream opened on POSTS with a pipeline of its own (not the shared hub stream).
const ownStreams: ChangeStream[] = []
const openOwnStreams = () => ownStreams.filter((cs) => !cs.closed).length

const memberIds = async (ctx: any, team: string) =>
  (await ctx.db.model(MEMBERS).find({ team }).toArray()).map((m: any) => m.userId)

beforeAll(async () => {
  process.env.MONGO_URI = getTestMongoUri()
  process.env.MONGO_DB = "mogobase_test_integration"
  await DB.connect()
  defineModel(MEMBERS)
  defineModel(POSTS)

  const realWatch = Collection.prototype.watch
  vi.spyOn(Collection.prototype, "watch").mockImplementation(function (this: Collection, ...a: any[]) {
    const cs = (realWatch as any).apply(this, a)
    if (this.collectionName === POSTS && Array.isArray(a[0]) && a[0].length) ownStreams.push(cs)
    return cs
  })

  // The watch on POSTS is registered AFTER a read, from what the read returned.
  query("rwTeamPosts", {
    args: v.object({ team: v.string() }),
    handler: async (args, ctx) => {
      ctx.watch(MEMBERS, { team: args.team })
      const ids = await memberIds(ctx, args.team)
      ctx.watch(POSTS, { authorId: { $in: ids } })
      return await ctx.db.model(POSTS).find({ authorId: { $in: ids } }).sort({ _id: 1 }).toArray()
    },
  })

  // Same, but the POSTS watch carries a non-$match stage, so it is a stream of its own —
  // which makes churn countable.
  query("rwTeamPostsOwnStream", {
    args: v.object({ team: v.string() }),
    handler: async (args, ctx) => {
      ctx.watch(MEMBERS, { team: args.team })
      const ids = await memberIds(ctx, args.team)
      ctx.watch(POSTS, [
        { $match: { "fullDocument.authorId": { $in: ids } } },
        { $project: { operationType: 1, fullDocument: 1 } },
      ])
      return await ctx.db.model(POSTS).find({ authorId: { $in: ids } }).sort({ _id: 1 }).toArray()
    },
  })

  query("rwTeamPostsPaged", {
    args: v.object({ team: v.string(), paginationOpts: v.any().optional() }),
    handler: async (args, ctx) => {
      ctx.watch(MEMBERS, { team: args.team })
      const ids = await memberIds(ctx, args.team)
      ctx.watch(POSTS, { authorId: { $in: ids } })
      return await (MongoPagingUpstream as any).find(ctx.db.model(POSTS), {
        query: { authorId: { $in: ids } },
        ...(args.paginationOpts || {}),
      })
    },
  })

  server = http.createServer()
  attachMogobaseWebSocket(server, "/ws", { refetchDebounceMs: 50 })
  await new Promise<void>((res) => server.listen(0, res))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((res) => server.close(() => res()))
})

beforeEach(async () => {
  const { db, client } = await connectTestMongo("mogobase_test_integration")
  await cleanCollections(db, [MEMBERS, POSTS])
  await client.close()
  await vi.waitFor(() => expect(openOwnStreams()).toBe(0))
  await DB.model(MEMBERS).insertOne({ _id: "m-u1" as any, team: "t1", userId: "u1" })
})

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const addMember = (userId: string) => DB.model(MEMBERS).insertOne({ _id: `m-${userId}` as any, team: "t1", userId })
const addPost = (id: string, authorId: string) => DB.model(POSTS).insertOne({ _id: id as any, authorId, title: id })
const frames = (client: ReturnType<typeof createWsClient>, type: string) => client.inbox.filter((m) => m.type === type)

describe("attachWs: a watch built from data the handler read follows that data", () => {
  it("query: a member who joined later wakes the subscription with their post", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "rwTeamPosts", args: { team: "t1" } })
    await client.waitFor((m) => m.type === "QueryResult" && m.success)
    await settle()

    // u2 is not a member yet: their post is outside the watch, and nothing arrives.
    const before = frames(client, "QueryResult").length
    await addPost("p-early", "u2")
    await settle()
    expect(frames(client, "QueryResult")).toHaveLength(before)

    // u2 joins: the members watch re-runs the query, whose new run now watches u2's posts.
    await addMember("u2")
    await client.waitFor((m) => m.type === "QueryResult" && m.data?.length === 1)
    await settle()

    await addPost("p-late", "u2")
    const update = await client.waitFor((m) => m.type === "QueryResult" && m.data?.length === 2)
    expect(update.data.map((p: any) => p._id)).toEqual(["p-early", "p-late"])
    await client.close()
  })

  it("paginated: the same, for a paginated subscription", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "paginated-query", name: "rwTeamPostsPaged", args: { team: "t1", paginationOpts: { limit: 10 } } })
    await client.waitFor((m) => m.type === "PaginatedQueryResult" && m.success)
    await settle()

    await addMember("u2")
    await client.waitFor((m) => m.type === "PaginatedQueryResult" && frames(client, "PaginatedQueryResult").length >= 2)
    await settle()

    await addPost("p-late", "u2")
    const update = await client.waitFor((m) => m.type === "PaginatedQueryResult" && m.data?.results?.length === 1)
    expect(update.data.results[0]._id).toBe("p-late")
    await client.close()
  })

  it("an unchanged watch stays open across re-runs; a changed one is replaced, not added", async () => {
    const client = createWsClient(`ws://localhost:${port}/ws`)
    await client.open()
    client.send({ type: "query", name: "rwTeamPostsOwnStream", args: { team: "t1" } })
    await client.waitFor((m) => m.type === "QueryResult" && m.success)
    await settle()
    expect(ownStreams).toHaveLength(1)

    // Three re-runs that ask for the same watch: no stream is opened or closed.
    for (const id of ["a", "b", "c"]) {
      await addPost(id, "u1")
      await client.waitFor((m) => m.type === "QueryResult" && m.data?.some((p: any) => p._id === id))
      await settle(150)
    }
    expect(ownStreams).toHaveLength(1)
    expect(openOwnStreams()).toBe(1)

    // The member set changes, so the watch does: the new stream opens and the old one closes.
    await addMember("u2")
    await vi.waitFor(() => expect(ownStreams).toHaveLength(2))
    await vi.waitFor(() => expect(openOwnStreams()).toBe(1))
    expect(ownStreams[0].closed).toBe(true)

    await client.close()
    await vi.waitFor(() => expect(openOwnStreams()).toBe(0))
  })
})
