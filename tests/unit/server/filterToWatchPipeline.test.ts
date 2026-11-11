// filterToWatchPipeline (exported from mogobase/server/sync, deprecated) kept its own prefixing,
// which left the fields inside $or/$and/$nor unprefixed: read off a change event, they named
// nothing, so a policy filter such as { $or: [{ org }, { shared: true }] } streamed no change —
// or, with a condition a missing field meets ({ deletedAt: null }), every tenant's (review round
// F12). It is now syncChangeMatch's $match, which both transports use.
import { describe, expect, it } from "vitest"
import { filterToWatchPipeline } from "@/server/sync"

describe("filterToWatchPipeline (review round F12)", () => {
  it("prefixes fields inside $or / $and / $nor too, as the transports' own narrowing does", () => {
    expect(filterToWatchPipeline({ $or: [{ org: "a" }, { shared: true }], deletedAt: null })).toEqual([
      { $match: { $or: [{ "fullDocument.org": "a" }, { "fullDocument.shared": true }], "fullDocument.deletedAt": null } },
    ])
  })

  it("an empty filter is no stage, as before", () => {
    expect(filterToWatchPipeline({})).toEqual([])
  })
})

describe("filterToWatchPipeline (review round F13)", () => {
  // Routed through syncChangeMatch, a filter using $where / $text / $near gave [] — no narrowing
  // — where it used to give a $match MongoDB refuses. mogobase's own sync-stream frames name the
  // model only, so an unnarrowed stream there loses no secrecy; an app streaming documents through
  // this export would send every tenant's to every client. It fails closed: the filter stays.
  it("keeps a filter a change stream cannot run, so the caller's stream fails rather than widens", () => {
    expect(filterToWatchPipeline({ $where: "this.org === 'a'" })).toEqual([{ $match: { $where: "this.org === 'a'" } }])
    expect(filterToWatchPipeline({ org: "a", $text: { $search: "x" } })).toEqual([{ $match: { "fullDocument.org": "a", $text: { $search: "x" } } }])
  })
})
