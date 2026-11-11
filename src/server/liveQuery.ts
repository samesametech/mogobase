// Live queries over a socket: the part of the WebSocket protocol both transports share
// (attachWs.ts for the Next.js custom server, ws.ts for `mogobase dev`). A transport owns
// the socket, the sync messages, and how a watch is opened; this owns what a subscription
// is, when its handler runs, and which watches it holds.
//
// Subscriptions live in SLOTS on a socket. A `query` or `paginated-query` without `sid` uses
// the socket's default slot — one subscription per socket, a new one replacing the old, as
// always. One WITH a client-chosen `sid` gets (or replaces) the slot for that sid, so one
// socket carries many subscriptions — one socket per browser tab instead of one per live
// query; `unsubscribe { sid }` removes one, and every frame for it echoes its `sid`. A slot owns
// everything about its subscription: its watches, backoffs, catch-up, page window and run
// queue, so siblings never share any of it, and one's failure tears down only itself.
//
// EVERY run of a subscription collects the watches its handler asks for: the first run, each
// change-triggered re-run, each loaded page. After a run SUCCEEDS the slot's open watches
// are reconciled to that set — new ones opened, dropped ones closed, unchanged ones left
// open, so a re-run that asks for the same watches costs no stream churn.
//
// Re-runs used to pass `noWatch`, so the watches of the first successful run were the
// subscription's forever. A handler that built its filter from data it read — a `$in` of
// member ids, the org a user currently belongs to — kept watching the first answer's ids,
// and never woke for a row matching the new ones.
//
// Watches still register only after a run succeeds, never inline: handlers call watch()
// before their auth gate, and a refused caller must not be left subscribed to another
// tenant's writes (an activity oracle). A failed run of the current subscription tears it
// down — every watch closed — and the client re-subscribes to resume.
//
// Runs, reconciles and teardowns of one SUBSCRIPTION (one slot) happen one at a time, in arrival
// order, so two runs can never interleave their watch sets; siblings run alongside, at most
// maxConcurrentRunsPerSocket at once, so a slow handler does not hold up the rest of the tab
// and one tab cannot take the whole database pool.

import type { Document } from "mongodb"
import handlers from "./handlers"
import { createRefetchScheduler } from "./refetchScheduler"
import { backoffDelay, STABLE_LIFE_MS } from "./backoff"
import { copyHeaders } from "./headers"

/** One `ctx.watch(...)` call, resolved by the transport. `key` is equal for equal watches. */
export type WatchSpec = { key: string; model: string; [field: string]: any }
export type OpenWatch = { close(): Promise<void> }

/** What the engine needs of a socket. */
export type LiveConnection = {
  send(payload: Record<string, unknown>): void
  isOpen(): boolean
  headers: any
  /**
   * Whether the socket's send buffer is over its limit — a client reading slower than its
   * frames arrive. While it is, change-triggered re-runs are held (no handler run, no frame)
   * and one runs once it drains. Without it, a slow client's frames piled up in the server's
   * memory until the heartbeat dropped the socket, about a minute later.
   */
  isBackedUp?(): boolean
}

export type LiveQueryOptions = {
  /** The database a request on this socket reads — resolved per run. */
  resolveActive(headers: any): Promise<any>
  /** Turn one ctx.watch() call into a spec. Runs inside the handler; must not throw. */
  watchSpec(model: string, pipelineOrFilter: Document[] | Document | undefined, options: any, active: any): WatchSpec
  /**
   * Open a watch that calls `onEvent` on every change it sees, and `onDead` if it stops for
   * good on its own (its stream failed and was not recovered) — not when the engine closes it.
   */
  openWatch(spec: WatchSpec, onEvent: () => void, onDead: () => void): Promise<OpenWatch>
  formatError(error: unknown): string
  /** Trailing debounce for change-triggered re-runs of one socket. */
  debounceMs: number
  /** How long a reopened watch must live before its earlier deaths stop counting. Default 60 s. */
  stableWatchMs?: number
  /**
   * The most rows a paginated subscription re-reads after a change (default 1000; never below
   * its first page). A client that scrolled further still has its rows until the next change;
   * that re-run answers with the first `maxRerunRows` rows and `hasNext: true`, so the list
   * shrinks to the cap and loadNext continues from there. Without a cap, a client that loaded
   * W rows cost ceil(W / 300) handler calls and a W-row frame on EVERY matching change — and
   * W is the client's to grow.
   */
  maxRerunRows?: number
  /**
   * The longest a burst of changes may hold a re-run back (default 1000 ms). The debounce waits
   * for a quiet gap; writes arriving faster than that (a webhook burst) froze updates for the
   * whole burst. With it, a long burst still re-runs every maxWaitMs.
   */
  maxWaitMs?: number
  /**
   * The most subscriptions one socket may hold at once — the default one and every `sid`'s
   * (default 32, DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET). A new one beyond it is refused with an error frame carrying its sid; nothing
   * is dropped silently.
   */
  maxSubscriptionsPerSocket?: number
  /**
   * The most runs of one socket's subscriptions in flight at once (default 4): one tab with many
   * subscriptions cannot flood the database pool. Runs of one subscription are always one at a
   * time.
   */
  maxConcurrentRunsPerSocket?: number
  /**
   * How long one run may hold one of those turns (default 5000 ms). Past it the turn is given
   * up — the run goes on, outside the cap: four handlers that never settle (a hung upstream call)
   * used to hold every turn, and the whole tab stopped, first answers included.
   */
  turnTimeoutMs?: number
}

/**
 * A client's id for one request, echoed on the answers it produces. Opaque to the server.
 *
 * Without it a client cannot tell an answer that was already in flight from the one it asked
 * for: ask again after a write, and the frame that arrives first may be the old run's,
 * computed before the write — a "stale" mark cleared by it is cleared too early. Every
 * request may carry `rid`; it becomes the subscription's current rid, and every answer
 * carries the rid that was current when the run producing it STARTED. So a frame with the
 * new rid holds data read after that request arrived, and a frame with an older one may not.
 * A request without `rid` changes nothing, and its answers carry none.
 */
export type Rid = string | number

// A client's id (rid, sid): a string of at most `maxLength` characters, or a finite number.
const readId = (value: unknown, maxLength: number): string | number | undefined =>
  (typeof value === "string" && value.length <= maxLength) || (typeof value === "number" && Number.isFinite(value)) ? value : undefined

/** A usable rid from a message: a string of at most 200 characters, or a finite number. */
export function readRid(value: unknown): Rid | undefined {
  return readId(value, 200)
}

/** `payload` plus the request's rid and sid, when it sent them. For a transport's own answer frames. */
export function withRid(payload: Record<string, unknown>, msg: any): Record<string, unknown> {
  return framePayload(payload, readRid(msg?.rid), readSid(msg?.sid) ?? undefined)
}

/**
 * A frame: `payload` plus its rid and sid, each when there is one — the one place a frame gets
 * them, built in one copy (every re-run of every subscription sends one).
 */
export function framePayload(payload: Record<string, unknown>, rid: Rid | undefined, sid: Sid | undefined): Record<string, unknown> {
  if (rid === undefined && sid === undefined) return payload
  return { ...payload, ...(rid === undefined ? {} : { rid }), ...(sid === undefined ? {} : { sid }) }
}

/**
 * A client's id for one of its subscriptions on a socket. Opaque to the server: a subscription
 * sent with one lives in its own slot (see the top of this file) and every frame for it carries
 * it back. A string of at most 64 characters, or a finite number; "1" and 1 are different sids.
 */
export type Sid = string | number

/**
 * The message's sid: undefined when it sent none (or `null`, as a JSON client writes "none"),
 * null when it sent one that is not usable.
 */
export function readSid(value: unknown): Sid | null | undefined {
  if (value === undefined || value === null) return undefined
  return readId(value, 64) ?? null
}

type QuerySub = { kind: "query"; name: string; args: any; rid?: Rid; live?: boolean; gen?: number }
type PagedSub = {
  kind: "paginated"
  name: string
  /** Its place among the slot's subscriptions (see Slot.answeredGen). */
  gen?: number
  /** A run of it has succeeded: its watches are open. */
  live?: boolean
  baseArgs: any
  rid?: Rid
  /**
   * The page size: the client's limit, or — when it sent none, or not a positive number — the
   * size the handler served its first page at (set then; `limitAsked` false until it is). A
   * fixed 10 there made loads come back in pages of 10 after a first page of the handler's
   * default 50, and a non-numeric limit made the re-run target NaN: it read the whole list.
   */
  limit: number
  limitAsked: boolean
  /**
   * The client's paginationOpts without the per-page keys (limit, next, previous): its sort,
   * paginatedField, fields, … — passed unchanged to every re-run and page load. The first page
   * goes to the handler with exactly the client's paginationOpts, so a load or re-run must
   * neither add an option the first page did not have (a sort defaulted to ascending while the
   * pager's own default ordered the first page made the next page walk the other way) nor drop
   * one it had: a re-run that lost `paginatedField: "createdAt"` reordered the list by _id, and
   * a load sent a createdAt cursor to an _id-ordered pager.
   */
  pageOpts: Record<string, unknown>
  /**
   * The cursor the first page was asked for at (`{ next }` or `{ previous }`), if any: a re-run
   * starts there too. Without it, a subscription that began mid-list (a restored scroll
   * position) was re-read from the top on its first change, and the client's list jumped. A
   * window later grown upward past it with loadPrevious is re-read from it, as before the
   * re-run was paged.
   */
  start?: { next?: string; previous?: string; count?: number }
  loadedCount: number
  /**
   * The least a re-run reads: the first page's capacity — the client's limit, or what the pager
   * actually served when it clamped that limit (fewer rows than asked, more remaining). A
   * client asking for 1000 got 300 on its first page; flooring at 1000 made the first write
   * grow its list to 1000 rows nobody loaded.
   */
  floor?: number
  hasPrevious: boolean
  hasNext: boolean
  nextCursor?: string
  previousCursor?: string
}
type Sub = QuerySub | PagedSub

/**
 * One subscription's place on a socket: the default slot (messages without `sid`) or one per
 * `sid`. Everything a subscription owns lives here, so siblings on one socket never share a
 * watch, a backoff, a catch-up or a run queue.
 */
type Slot = {
  /** Its key in `Socket.slots`: "" for the default slot, else the sid with its type. */
  key: string
  /**
   * Its re-runs' key in the scheduler — its own, not the sid's: a sid unsubscribed and taken
   * again shared the old slot's, and the new subscription's re-runs waited behind the old one's
   * run still in flight (forever, if it hung).
   */
  runKey: string
  /** Echoed on every frame for it; undefined for the default slot. */
  sid?: Sid
  sub?: Sub
  watches: Map<string, OpenWatch>
  /** Consecutive deaths per watch key (died after opening), reset by an event or a long life. */
  deaths: Map<string, number>
  /** Consecutive failed opens per watch key, reset when it opens. Kept apart from `deaths`. */
  openFailures: Map<string, number>
  /** Its runs, one at a time (see enqueue). */
  queue: Promise<void>
  /** The next change-triggered run is the catch-up after a new watch opened (see catchUpAfter). */
  catchUp: boolean
  /** Pending watch retries (see retryWatch); cleared when the subscription ends or is replaced. */
  retryTimers: Set<ReturnType<typeof setTimeout>>
  /** When each open watch opened: a watch that lived a while had recovered. */
  openedAt: Map<string, number>
  /** The spec of every watch the subscription wants — open or not — so a retry can reopen one. */
  specs: Map<string, WatchSpec>
  /** A change arrived while the socket was backed up: it re-runs once the socket drains. */
  dirty: boolean
  /** Unsubscribed: nothing more is sent for it, not even a run already in flight. */
  ended: boolean
  /** Its subscription ended with an `ended: true` frame (failRun), which also ended its pending loads. */
  endedSent: boolean
  /** Subscriptions the slot has had, counted; each one's `gen` is its number. */
  subGen: number
  /**
   * The newest subscription the slot has answered for. A replaced subscription's run answers after
   * its replacement's only when it overran the bounded wait (waitAtMost) — and then it is dropped:
   * sent, a client without rids showed the old query's rows under the new one's arguments.
   */
  answeredGen: number
  /**
   * The slot's queue generation: a replacement that stops waiting for the old queue (waitAtMost)
   * starts a new one. A change-triggered re-run queued on an older one is skipped — it reads
   * `slot.sub` when it starts, and ran the replacement beside the replacement's own runs.
   */
  chain: number
}

type Socket = {
  id: string
  conn: LiveConnection
  closed: boolean
  slots: Map<string, Slot>
  /**
   * The run queue a removed slot left behind, per key, until it settles: a slot made again for
   * the same key (a sid reused right after its subscription failed) runs after it, so its
   * frames never overtake the old one's.
   */
  tails: Map<string, Promise<void>>
  /** Runs holding a turn on this socket (maxConcurrentRunsPerSocket), and those waiting for one. */
  running: number
  /** Waiting runs a client asked for — a first run, a page load: they get a turn first. */
  waitingAsked: (() => void)[]
  /** Waiting change-triggered re-runs. */
  waiting: (() => void)[]
  /** Runs that gave up their turn on turnTimeoutMs and are still going (at most maxConcurrentRunsPerSocket). */
  overtime: number
  /**
   * Removed slots whose run is still going (its watch opens can take a cold stream's 10 s): they
   * count toward maxSubscriptionsPerSocket until it settles, or for at most LINGER_LIMIT_MS (15 s).
   * Uncounted, a subscribe/unsubscribe loop on fresh sids held any number of stream opens — pooled
   * connections — at once; counted for good, a hung removed run held a place for good.
   */
  lingering: number
}

export type LiveQueries = {
  open(id: string, conn: LiveConnection): void
  /** Handles `query`, `paginated-query`, the two load messages and `unsubscribe`; false for any other type. */
  handle(id: string, msg: any): boolean
  close(id: string): Promise<void>
  shutdown(): Promise<void>
  /** Test hook. */
  _socket?(id: string): unknown
  /** Test hook. */
  _socketState?(
    id: string
  ): { watches: number; specs: number; deaths: number; openFailures: number; subscriptions: number; retryTimers: number } | undefined
}

/**
 * The largest page a re-run asks a handler for. mongo-cursor-pagination clamps any `limit`
 * to its `MAX_LIMIT` — 300 unless an app raises it — without saying so.
 */
export const RERUN_PAGE_LIMIT = 300

/** A client's page limit, if it is a positive number. */
function pageLimitOf(limit: unknown): number | undefined {
  const n = typeof limit === "number" ? limit : typeof limit === "string" && limit.trim() ? Number(limit) : NaN
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined
}

/** The cursor a client's first page was asked for at, as `{ next }` or `{ previous }`. */
function startCursorOf(paginationOpts: any): { next?: string; previous?: string } | undefined {
  if (typeof paginationOpts?.next === "string" && paginationOpts.next) return { next: paginationOpts.next }
  if (typeof paginationOpts?.previous === "string" && paginationOpts.previous) return { previous: paginationOpts.previous }
  return undefined
}

/** The paginationOpts a client sent, without the per-page keys a load or re-run sets itself. */
function pageOptsOf(paginationOpts: any): Record<string, unknown> {
  const { limit: _limit, next: _next, previous: _previous, ...rest } =
    paginationOpts && typeof paginationOpts === "object" ? paginationOpts : ({} as Record<string, unknown>)
  return rest
}

/**
 * Re-read the first `target` rows of a paginated query, in pages of at most `pageLimit`,
 * walking the `next` cursor — and answer in the shape a single page has (`previous` /
 * `hasPrevious` from the first page, `next` / `hasNext` from the last).
 *
 * A re-run used to ask for the whole loaded window in ONE call, and the pager clamped it to
 * 300: a client scrolled past 300 rows got its list cut back to 300 on the next write, and
 * its scroll position jumped. A window of 300 rows or fewer is still exactly one call.
 *
 * Stops early when the handler says there is nothing more, returns an empty page, or hands
 * back the cursor it was given — never loops on a handler that does not advance.
 */
export async function readWindow(
  target: number,
  readPage: (paginationOpts: Record<string, unknown>) => Promise<any>,
  pageOpts: Record<string, unknown>,
  pageLimit: number = RERUN_PAGE_LIMIT,
  /**
   * Where the window starts: the first page's `{ next }` cursor, or `{ previous, count }` — the
   * `count` rows before that cursor. A `previous` start is read for `count` rows, not `target`:
   * read for the whole window, it fetched rows before the cursor that the window never had,
   * and dropped the ones a loadNext had added after it.
   */
  start?: { next?: string; previous?: string; count?: number },
  /**
   * Called when nothing is left on the window's side of its start cursor — every row before a
   * `previous` start, or after a `next` start, is gone — and the window was read from the top
   * instead: the caller forgets the start, so later re-runs read from the top too.
   */
  onFromTop?: () => void
): Promise<any> {
  const results: any[] = []
  let first: any
  let last: any
  let cursor: string | undefined = typeof start?.next === "string" ? start.next : undefined
  // The window, in one page's shape: previous / hasPrevious from the earliest page read.
  const windowOf = (next: string | undefined, hasNext: boolean) => ({
    ...first,
    results,
    previous: first.previous,
    hasPrevious: first.hasPrevious,
    next,
    hasNext,
  })
  // A window that starts `count` rows before a cursor: read those back first, a page at a time
  // walking backward — `count` can be more than one page holds (a pager without the 300 clamp),
  // and read in one page the window lost its earliest rows — then walk forward from the page
  // next to the cursor.
  if (typeof start?.previous === "string") {
    let need = Math.min(start.count ?? target, target)
    let before = start.previous
    let nearest: any
    for (;;) {
      const rs = await readPage({ ...pageOpts, limit: Math.max(1, Math.min(need, pageLimit)), previous: before })
      if (!rs?.results) throw new Error("Invalid paginated result")
      nearest ??= rs
      first = rs // the earliest page read: its previous / hasPrevious are the window's
      results.unshift(...rs.results)
      need -= rs.results.length
      if (need <= 0 || !rs.hasPrevious || !rs.results.length || !rs.previous || rs.previous === before) break
      before = rs.previous
    }
    if (results.length) {
      last = nearest
      if (results.length >= target || !nearest.hasNext || !nearest.next) return windowOf(last.next, last.hasNext)
      cursor = nearest.next
    } else {
      // No row precedes the cursor any more (all deleted, or filtered out). The empty page
      // answers hasNext with no `next` to continue from, so the window came back empty — the
      // client's list wiped though every row from the cursor on still exists, and loadNext
      // stuck on an empty page. With nothing before it, the window is the top of the list.
      first = undefined
      cursor = undefined
      onFromTop?.()
    }
  }
  for (;;) {
    const limit = Math.max(1, Math.min(target - results.length, pageLimit))
    const at = cursor !== undefined ? { next: cursor } : {}
    const rs = await readPage({ ...pageOpts, limit, ...at })
    if (!rs?.results) throw new Error("Invalid paginated result")
    if (cursor !== undefined && cursor === start?.next && !results.length && !rs.results.length && rs.hasPrevious) {
      // Nothing after the window's start cursor any more: the empty page answers hasPrevious with
      // no `previous` to go back from, so loadPrevious answered empty pages forever. Read from the
      // top instead (no row is skipped, as one would be going back from the exclusive cursor).
      cursor = undefined
      onFromTop?.()
      continue
    }
    first ??= rs
    last = rs
    results.push(...rs.results)
    const advanced = rs.hasNext && rs.next && rs.next !== cursor && rs.results.length > 0
    if (results.length >= target) break
    if (!advanced) {
      // Stopped on a handler that claims more but did not advance (no cursor, the same cursor,
      // an empty page): its cursor would only fetch the same page again on the next load, so
      // the window ends here.
      if (rs.hasNext) return windowOf(undefined, false)
      break
    }
    cursor = rs.next
  }
  return windowOf(last.next, last.hasNext)
}

/** Default cap on the rows a paginated re-run reads (LiveQueryOptions.maxRerunRows). */
export const DEFAULT_MAX_RERUN_ROWS = 1000
/** Default for LiveQueryOptions.maxWaitMs: a burst of changes still re-runs once a second. */
export const DEFAULT_MAX_WAIT_MS = 1000
/** The send buffer above which a connection counts as backed up (LiveConnection.isBackedUp), both transports. */
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024
/** How often a backed-up connection is checked for having drained. */
const DRAIN_POLL_MS = 100
/**
 * Default for LiveQueryOptions.maxSubscriptionsPerSocket: about three times the ~10 live queries
 * a busy app tab shows, and at most a third of the driver's default maxPoolSize (100) even if
 * every one of them held a change stream of its own. (100, the first default, was the whole pool.)
 */
export const DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET = 32
/** Default for LiveQueryOptions.maxConcurrentRunsPerSocket. */
export const DEFAULT_MAX_CONCURRENT_RUNS_PER_SOCKET = 4
/** Default for LiveQueryOptions.turnTimeoutMs. */
export const DEFAULT_TURN_TIMEOUT_MS = 5000
/**
 * The longest a removed subscription's run counts toward maxSubscriptionsPerSocket: what it is
 * counted for — watch opens, which take a pooled connection — wait at most 10 s for their stream
 * to start (STREAM_START_TIMEOUT_MS). Counted until its run settled, one whose handler hung held a
 * place for the socket's life, and 32 of them left it refusing everything.
 */
const LINGER_LIMIT_MS = 15_000

const LIVE_TYPES = new Set([
  "query",
  "paginated-query",
  "paginated-query-load-next",
  "paginated-query-load-previous",
  "unsubscribe",
])

// The frame type that answers a message of this type (for a refusal before any run).
const answerTypeOf = (type: string): string =>
  type === "query" ? "QueryResult" : type === "paginated-query" ? "PaginatedQueryResult" : type === "unsubscribe" ? "Unsubscribed" : "PaginatedQueryPage"

// A load message's direction; undefined for any other type.
const directionOf = (type: string): "next" | "previous" | undefined =>
  type === "paginated-query-load-next" ? "next" : type === "paginated-query-load-previous" ? "previous" : undefined

/**
 * A numeric option, checked: a number of at least `min` (Infinity only where `infinity` allows
 * it), else its default with a warning. `?? default` lets NaN through — from an unset environment
 * variable, Number(undefined) — and NaN broke each option its own way: a run cap that made every
 * run wait forever, a subscription cap that was no cap, a maxRerunRows that re-read the whole
 * collection on every change, a debounce or heartbeat that fired every millisecond.
 */
export function numberOption(name: string, value: unknown, fallback: number, min: number, infinity = true): number {
  if (value === undefined) return fallback
  if (typeof value === "number" && value >= min && (infinity || Number.isFinite(value))) return value
  console.warn(`[mogobase] ${name}: ${String(value)} is not a number of at least ${min} — using the default, ${fallback}`)
  return fallback
}

export function createLiveQueries(opts: LiveQueryOptions): LiveQueries {
  const sockets = new Map<string, Socket>()
  const debounceMs = numberOption("refetchDebounceMs", opts.debounceMs, 100, 0, false)
  const maxWaitMs = numberOption("refetchMaxWaitMs", opts.maxWaitMs, DEFAULT_MAX_WAIT_MS, 0)
  const scheduler = createRefetchScheduler({ debounceMs, maxWaitMs })
  // The per-socket limits and the re-run cap: a number of at least 1 (Infinity allowed), whole —
  // a fractional maxRerunRows reached the pager as a page limit.
  const limitOf = (name: string, value: unknown, fallback: number): number => {
    const n = numberOption(name, value, fallback, 1)
    return Number.isFinite(n) ? Math.floor(n) : n
  }
  const maxRerunRows = limitOf("maxRerunRows", opts.maxRerunRows, DEFAULT_MAX_RERUN_ROWS)
  const maxSubscriptions = limitOf("maxSubscriptionsPerSocket", opts.maxSubscriptionsPerSocket, DEFAULT_MAX_SUBSCRIPTIONS_PER_SOCKET)
  const maxRuns = limitOf("maxConcurrentRunsPerSocket", opts.maxConcurrentRunsPerSocket, DEFAULT_MAX_CONCURRENT_RUNS_PER_SOCKET)
  let slotSeq = 0


  const send = (s: Socket, slot: Slot, payload: Record<string, unknown>, rid?: Rid, sub?: Sub) => {
    if (s.closed || slot.ended || !s.conn.isOpen()) return
    if (sub?.gen !== undefined) {
      if (sub.gen < slot.answeredGen) return // overtaken by a newer subscription's answer (see answeredGen)
      slot.answeredGen = sub.gen
    }
    s.conn.send(framePayload(payload, rid, slot.sid))
  }

  // An answer to a message no slot takes (refused before any run): its rid and sid echoed.
  const reply = (s: Socket, payload: Record<string, unknown>, msg: any) => {
    if (!s.closed && s.conn.isOpen()) s.conn.send(withRid(payload, msg))
  }

  const turnTimeoutMs = limitOf("turnTimeoutMs", opts.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS)
  // setTimeout fires after 1 ms for anything above this (Infinity included), which gave every
  // turn up at once: a timeout this long is no timeout.
  const MAX_TIMER_MS = 2 ** 31 - 1

  // At most maxRuns runs of one socket hold a turn at a time. A run the client asked for (`asked`)
  // waits ahead of change-triggered re-runs: in a write burst those queued up first, and the
  // answer the user was waiting for came back after every background refresh. A turn held past
  // turnTimeoutMs is given up (the run goes on, outside the cap), so a few handlers that never
  // settle cannot stop the rest of the socket — but at most maxRuns runs may be over time at once
  // (`overtime`): handed over without that bound, hung handlers added maxRuns runs per socket
  // every turnTimeoutMs. Past it, a run keeps its turn, and tries again a timeout later.
  // Returns the turn's release, safe to call more than once.
  const takeTurn = async (s: Socket, asked: boolean): Promise<() => void> => {
    if (s.running < maxRuns) s.running++
    else await new Promise<void>((resolve) => (asked ? s.waitingAsked : s.waiting).push(resolve))
    let held = true
    let over = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const handOver = () => {
      const next = s.waitingAsked.shift() ?? s.waiting.shift()
      if (next) next() // handed over: `running` unchanged
      else s.running--
    }
    const arm = () => {
      if (turnTimeoutMs > MAX_TIMER_MS) return
      timer = setTimeout(giveUp, turnTimeoutMs)
      timer.unref?.()
    }
    const giveUp = () => {
      if (!held) return
      if (s.overtime >= maxRuns) return arm()
      held = false
      over = true
      s.overtime++
      handOver()
    }
    arm()
    return () => {
      if (timer) clearTimeout(timer)
      if (over) {
        over = false
        s.overtime--
      } else if (held) {
        held = false
        handOver()
      }
    }
  }

  // One slot's tasks one at a time, in order. Nothing runs for a socket that has closed, or for
  // an unsubscribed slot: its answers would go nowhere, and its handlers still read the database.
  const enqueue = (s: Socket, slot: Slot, task: () => Promise<void>): Promise<void> => {
    slot.queue = slot.queue
      .then(async () => {
        if (!s.closed && !slot.ended) await task()
      })
      .catch((err) => console.warn("[mogobase/live] run failed:", err))
    return slot.queue
  }

  // A handler run (with its request's database resolved) inside one of the socket's run turns.
  // The turn covers the run only: held across the watch opens after it too — which can wait
  // seconds for a cold stream to start — it kept the siblings' first answers waiting.
  // A run that waited for its turn while its socket closed or its sid was unsubscribed does not
  // run (it throws `skipped`, which its caller drops quietly): with many sids queued behind the
  // cap, every one of them still ran its handler after the tab had gone.
  const withTurn = async <T>(s: Socket, slot: Slot, run: () => Promise<T>, asked = false): Promise<T> => {
    const release = await takeTurn(s, asked)
    try {
      if (s.closed || slot.ended) throw skipped
      return await run()
    } finally {
      release()
    }
  }
  const skipped = new Error("[mogobase/live] skipped: the socket closed or the subscription ended")

  // On a sid's frame that ends its subscription (the slot is gone): `ended: true`. Any other
  // failure for a sid answers one request — a replaced subscription's own, a load — and the
  // sid's subscription may well be alive. The default subscription's frames stay as they were.
  const endedMark = (slot: Slot, ends: boolean): Record<string, unknown> => (ends && slot.sid !== undefined ? { ended: true } : {})

  // A failed run's answer, the one way every run kind gives it: when the subscription is still the
  // slot's, its teardown starts first — synchronously, the slot leaves the socket at once — then
  // the frame goes out (`ended` for a sid), and the watch closes finish in the background: a
  // re-subscribe of the sid while they close is never the one the frame ends.
  const failRun = (s: Socket, slot: Slot, sub: Sub, frame: Record<string, unknown>, error: unknown, rid: Rid | undefined) => {
    const ends = current(s, slot, sub)
    const closing = ends ? teardown(s, slot) : undefined
    send(s, slot, { ...frame, success: false, error: opts.formatError(error), ...endedMark(slot, ends) }, rid, sub)
    if (ends && slot.sid !== undefined) slot.endedSent = true
    void closing
  }

  const closeWatch = async (w: OpenWatch) => {
    try {
      await w.close()
    } catch {}
  }

  const keyOf = (sid: Sid | undefined) => (sid === undefined ? "" : `${typeof sid}:${sid}`)

  // The slot for `sid` (the default slot without one), made when `create` asks and the socket
  // has room; undefined when it has none.
  const slotFor = (s: Socket, sid: Sid | undefined, create: boolean): Slot | undefined => {
    const key = keyOf(sid)
    const existing = s.slots.get(key)
    if (existing || !create || s.slots.size + s.lingering >= maxSubscriptions) return existing
    const slot: Slot = {
      key,
      runKey: `${s.id}\u0000${slotSeq++}`,
      sid,
      watches: new Map(),
      deaths: new Map(),
      openFailures: new Map(),
      queue: s.tails.get(key) ?? Promise.resolve(),
      catchUp: false,
      retryTimers: new Set(),
      openedAt: new Map(),
      specs: new Map(),
      dirty: false,
      ended: false,
      endedSent: false,
      subGen: 0,
      answeredGen: 0,
      chain: 0,
    }
    s.tails.delete(key)
    s.slots.set(key, slot)
    return slot
  }

  // End a slot's subscription: its watches closed, its retries and pending re-run cancelled, and
  // the slot gone from the socket — a sid never used again costs nothing. Its queue is kept as
  // the key's tail until it settles (see Socket.tails).
  const teardown = async (s: Socket, slot: Slot) => {
    slot.sub = undefined
    if (s.slots.get(slot.key) === slot) {
      s.slots.delete(slot.key)
      if (!s.closed) {
        s.lingering++
        let counted = true
        const uncount = () => {
          if (!counted) return
          counted = false
          clearTimeout(limit)
          s.lingering--
        }
        const limit = setTimeout(uncount, LINGER_LIMIT_MS)
        limit.unref?.()
        void slot.queue.then(uncount)
      }
      // An unsubscribed slot sends nothing more, so the sid's next subscription need not wait for
      // its run (a remount re-subscribing at once waited up to a cold stream's 10 s start).
      if (!s.closed && !slot.ended) {
        const tail = slot.queue
        s.tails.set(slot.key, tail)
        void tail.then(() => {
          if (s.tails.get(slot.key) === tail) s.tails.delete(slot.key)
        })
      }
    }
    resetSlotState(slot)
    slot.openedAt.clear()
    const open = [...slot.watches.values()]
    slot.watches.clear()
    await Promise.all(open.map(closeWatch))
  }

  // A watch whose stream died on its own used to stay registered as open, so every later
  // reconcile skipped it and the query never updated again. It is dropped and reopened, and
  // once it is back the subscription re-runs, reading whatever it missed. One that keeps
  // dying backs off instead of spinning: the 2nd consecutive death waits 1 s, then 2 s, … 30 s.
  //
  // This sits on top of the hub's own reconnect on purpose. The hub keeps a shared stream alive
  // for every subscriber of its slot and says "error" only when that fails three times in a row;
  // this retry is per subscription, and is the only one a watch with a stream of its own (a
  // pipeline watch, every watch on ws.ts) or a watch that failed to open has.
  const watchDied = (s: Socket, slot: Slot, key: string, w: OpenWatch) => {
    if (slot.watches.get(key) !== w) return
    slot.watches.delete(key)
    void closeWatch(w)
    // A watch that ran a while had recovered: its earlier deaths no longer count, so this one
    // is retried at once rather than after a backoff earned hours ago.
    if (Date.now() - (slot.openedAt.get(key) ?? Date.now()) > (opts.stableWatchMs ?? STABLE_LIFE_MS)) slot.deaths.delete(key)
    slot.openedAt.delete(key)
    retryWatch(s, slot, slot.deaths, key)
  }

  // Reopen the watch: at once the first time, then after 1 s, 2 s, … 30 s while it keeps
  // failing. `counts` is `deaths` or `openFailures`: a watch that finally opened does not carry
  // its failed opens into its first death, and one that opens fine but keeps dying still backs
  // off. Only the watch is retried, not the handler: a retry used to be a whole re-run, so a
  // watch that can never start (a pipeline or option the server rejects) cost a handler run, a
  // catch-up run and a frame on every attempt, for the life of the socket.
  const retryWatch = (s: Socket, slot: Slot, counts: Map<string, number>, key: string) => {
    const sub = slot.sub
    if (!sub) return
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    const retry = () => void enqueue(s, slot, () => reopenWatch(s, slot, sub, key))
    if (n === 1) return retry()
    const timer = setTimeout(() => {
      slot.retryTimers.delete(timer)
      retry()
    }, backoffDelay(n - 1))
    timer.unref?.()
    slot.retryTimers.add(timer)
  }

  // The retry itself: if the subscription still wants the watch, open it; once it is open, re-run
  // the subscription, since writes made while it was down were seen by nothing.
  const reopenWatch = async (s: Socket, slot: Slot, sub: Sub, key: string) => {
    if (!current(s, slot, sub) || slot.watches.has(key)) return
    const spec = slot.specs.get(key)
    if (!spec) return // a re-run since has dropped it
    if (await openOne(s, slot, sub, key, spec)) onEvent(s, slot)
  }

  // A retry belongs to the subscription whose watch failed: when it ends or is replaced, its
  // pending retries must not fire for whatever subscription comes next.
  const clearRetries = (slot: Slot) => {
    for (const timer of slot.retryTimers) clearTimeout(timer)
    slot.retryTimers.clear()
  }

  // Open one watch for `sub`; true when it is now registered.
  const openOne = async (s: Socket, slot: Slot, sub: Sub, key: string, spec: WatchSpec): Promise<boolean> => {
    let w: OpenWatch
    let opened: OpenWatch | undefined
    let diedOpening = false
    try {
      w = await opts.openWatch(
        spec,
        () => {
          slot.deaths.delete(key)
          onEvent(s, slot)
        },
        () => {
          if (opened) watchDied(s, slot, key, opened)
          else diedOpening = true
        }
      )
    } catch (err) {
      // A watch that could not open (a connection blip, a hub that could not start its
      // stream) used to be logged and forgotten: the answer went out as a success, nothing
      // was watching, and the screen never updated. It is retried like a watch that died.
      console.warn(`[mogobase/live] could not watch ${spec.model}:`, err)
      if (current(s, slot, sub)) retryWatch(s, slot, slot.openFailures, key)
      return false
    }
    opened = w
    // The socket closed, or a newer subscription took over, while it opened.
    if (!current(s, slot, sub)) {
      await closeWatch(w)
      return false
    }
    // Died before it ever started (a pipeline the server rejects): a failed open, not an open
    // watch — so no catch-up run for it, and the open-failure backoff.
    if (diedOpening) {
      await closeWatch(w)
      retryWatch(s, slot, slot.openFailures, key)
      return false
    }
    slot.openFailures.delete(key)
    // Opened twice at once: the first stays, this one closes — overwritten, the first was never
    // closed, and kept firing for the slot. Not an open of this call's (false): counted as one, it
    // scheduled a catch-up run or a re-run for a watch that never went down. (Defensive: a slot's
    // opens are serialized on its queue, and a stale queue's runs are skipped — slot.chain.)
    if (slot.watches.has(key)) {
      await closeWatch(w)
      return false
    }
    slot.watches.set(key, w)
    slot.openedAt.set(key, Date.now())
    return true
  }

  // Make the slot's open watches `specs` ("replace"), or add `specs` to them ("add", for a
  // page loaded onto the window). New watches open BEFORE dropped ones close, so a watch whose
  // filter changed has no gap in which a write goes unseen. Opens run in parallel, and so do
  // closes: a handler with four watches on cold streams does not wait for four opens in turn.
  // Each slot opens its own watches — siblings asking for the same one each hold a hub
  // subscription, so one leaving never closes the other's.
  const reconcile = async (s: Socket, slot: Slot, sub: Sub, specs: WatchSpec[], mode: "replace" | "add"): Promise<boolean> => {
    const desired = new Map(specs.map((spec) => [spec.key, spec]))
    if (mode === "replace") {
      slot.specs = new Map(desired)
      // Counts for watches the subscription no longer wants are never read again: dropped, so a
      // long-lived socket whose watch key changes every run does not collect one per key.
      for (const counts of [slot.deaths, slot.openFailures]) for (const key of [...counts.keys()]) if (!desired.has(key)) counts.delete(key)
    } else for (const [key, spec] of desired) slot.specs.set(key, spec)
    const fresh = [...desired].filter(([key]) => !slot.watches.has(key))
    const openedNew = (await Promise.all(fresh.map(([key, spec]) => openOne(s, slot, sub, key, spec)))).some(Boolean)
    if (mode === "add" || !current(s, slot, sub)) return openedNew
    const dropped = [...slot.watches].filter(([key]) => !desired.has(key))
    for (const [key] of dropped) {
      slot.watches.delete(key)
      slot.openedAt.delete(key)
    }
    await Promise.all(dropped.map(([, w]) => closeWatch(w)))
    return openedNew
  }

  // A subscription that was already live opened a watch it did not have — a filter built from
  // what this run read, such as a `$in` of member ids that just grew. The read happened before
  // the watch opened, so a write in between went unseen by both. Run once more now that it is
  // open. A catch-up run never schedules another, so a watch that changes every run cannot
  // loop. A subscription's first run has the same gap (its watches open after its read) and is
  // not caught up: that would double the cost of every subscribe.
  //
  // Not done instead by opening the new watch at the read's cluster time (startAtOperationTime):
  // a hub watch joins a stream shared by every socket on that (database, model), which cannot
  // start at one subscriber's read; and a handler's reads are its own (several collections,
  // sessions, or none), so the engine has no one operation time to start from.
  const catchUpAfter = (s: Socket, slot: Slot, sub: Sub, openedNew: boolean, isCatchUp: boolean) => {
    const wasLive = sub.live === true
    sub.live = true
    if (!openedNew || !wasLive || isCatchUp || !current(s, slot, sub)) return
    slot.catchUp = true
    scheduleRun(s, slot)
  }

  // The handler context for one run: ONE resolved database for the handler and the watches it
  // asks for, and a watch() that only collects — nothing opens until the run has succeeded.
  const runContext = async (s: Socket, specs: WatchSpec[]) => {
    // A copy per run, which its resolver call and its handler share: the socket's one view, a
    // handler's ctx.headers.set reached every later run on the socket — and the DB resolver.
    const headers = copyHeaders(s.conn.headers)
    const active = await opts.resolveActive(headers)
    return {
      headers,
      db: active,
      _resolved: true,
      watch: (model: string, pipelineOrFilter?: Document[] | Document, options?: any) => {
        specs.push(opts.watchSpec(model, pipelineOrFilter, options, active))
      },
    }
  }

  const current = (s: Socket, slot: Slot, sub: Sub) => !s.closed && s.slots.get(slot.key) === slot && slot.sub === sub

  // `requested`: a client asked for this run, so it is answered even if a newer request has
  // since replaced the subscription. A change-triggered re-run of a replaced one is dropped.
  const runQuery = async (s: Socket, slot: Slot, sub: QuerySub, requested: boolean, isCatchUp = false) => {
    const rid = sub.rid
    const specs: WatchSpec[] = []
    try {
      const data = await withTurn(
        s,
        slot,
        async () => {
          // A re-run whose subscription was replaced while it waited for its turn answers nobody.
          if (!requested && !current(s, slot, sub)) throw skipped
          return handlers._runQuery(sub.name, sub.args, await runContext(s, specs))
        },
        requested
      )
      if (current(s, slot, sub)) catchUpAfter(s, slot, sub, await reconcile(s, slot, sub, specs, "replace"), isCatchUp)
      // A change-triggered re-run whose subscription was replaced — before it ran, or while
      // its watches opened — answers nobody: the newer subscription's answer is on its way.
      if (!requested && !current(s, slot, sub)) return
      send(s, slot, { type: "QueryResult", success: true, data }, rid, sub)
    } catch (error) {
      if (error === skipped || (!requested && !current(s, slot, sub))) return
      failRun(s, slot, sub, { type: "QueryResult" }, error, rid)
    }
  }

  // How many rows a change-triggered re-run reads: the loaded window (at least the first page),
  // capped at maxRerunRows — but never below the first page.
  const rerunTarget = (sub: PagedSub) => {
    const floor = sub.floor ?? sub.limit
    return Math.min(Math.max(sub.loadedCount, floor), Math.max(maxRerunRows, floor))
  }

  const setWindow = (sub: PagedSub, rs: any) => {
    sub.loadedCount = rs.results.length
    sub.hasPrevious = !!rs.hasPrevious
    sub.hasNext = !!rs.hasNext
    sub.nextCursor = rs.hasNext ? rs.next : undefined
    sub.previousCursor = rs.hasPrevious ? rs.previous : undefined
  }

  const startPaged = async (s: Socket, slot: Slot, sub: PagedSub, args: any) => {
    const rid = sub.rid
    const specs: WatchSpec[] = []
    try {
      const rs = await withTurn(s, slot, async () => handlers._runQuery(sub.name, args, await runContext(s, specs)), true)
      if (!rs?.results) throw new Error("Invalid paginated result. Return value must come from MongoPaging.find")
      if (current(s, slot, sub)) {
        setWindow(sub, rs)
        if (!sub.limitAsked) sub.limit = rs.hasNext ? Math.max(1, rs.results.length) : Math.max(10, rs.results.length)
        sub.floor = rs.hasNext && rs.results.length < sub.limit ? rs.results.length : sub.limit
        // A window that starts before a cursor is these rows: a re-run reads back exactly them.
        if (sub.start?.previous) sub.start = { previous: sub.start.previous, count: rs.results.length }
        catchUpAfter(s, slot, sub, await reconcile(s, slot, sub, specs, "replace"), false)
      }
      send(s, slot, { type: "PaginatedQueryResult", success: true, data: rs }, rid, sub)
    } catch (error) {
      if (error === skipped) return
      failRun(s, slot, sub, { type: "PaginatedQueryResult" }, error, rid)
    }
  }

  // Re-read the loaded window after a change — all of it, however far the client scrolled.
  const refetchPaged = async (s: Socket, slot: Slot, sub: PagedSub, isCatchUp = false) => {
    const rid = sub.rid
    const specs: WatchSpec[] = []
    try {
      // A turn per page, not one across the whole window: a re-run of thousands of rows is several
      // handler calls, and held as one turn it kept the siblings waiting through all of them.
      let ctx: Awaited<ReturnType<typeof runContext>> | undefined
      const rs = await readWindow(
        // Floor at the first page's capacity so a static (non-virtualized) list that never
        // calls loadNext still picks up newly-appended rows past loadedCount. Capped at
        // maxRerunRows (see LiveQueryOptions): the cost of a change must not grow with scrolling.
        rerunTarget(sub),
        (paginationOpts) =>
          withTurn(s, slot, async () => {
            // Replaced since the window walk began: its remaining pages would be read for nobody.
            if (!current(s, slot, sub)) throw skipped
            return handlers._runQuery(sub.name, { ...sub.baseArgs, paginationOpts }, (ctx ??= await runContext(s, specs)))
          }),
        sub.pageOpts,
        RERUN_PAGE_LIMIT,
        sub.start,
        () => (sub.start = undefined) // read from the top: so is every later re-run
      )
      if (!current(s, slot, sub)) return
      setWindow(sub, rs)
      catchUpAfter(s, slot, sub, await reconcile(s, slot, sub, specs, "replace"), isCatchUp)
      if (!current(s, slot, sub)) return
      send(s, slot, { type: "PaginatedQueryResult", success: true, data: rs }, rid, sub)
    } catch (error) {
      // Refused (access revoked since the last run) or failing: stop streaming, or every
      // write to the watched collection keeps producing a frame. Its siblings are untouched.
      if (error === skipped || !current(s, slot, sub)) return
      failRun(s, slot, sub, { type: "PaginatedQueryResult" }, error, rid)
    }
  }

  const loadMore = async (s: Socket, slot: Slot, sub: PagedSub, direction: "next" | "previous") => {
    const rid = sub.rid
    // Read here, not when the message arrived: a re-run queued ahead of it moves the cursor.
    const cursor = direction === "next" ? sub.nextCursor : sub.previousCursor
    if (!cursor) {
      return send(
        s,
        slot,
        {
          type: "PaginatedQueryPage",
          success: true,
          direction,
          data: { results: [], hasPrevious: sub.hasPrevious, hasNext: sub.hasNext },
        },
        rid,
        sub
      )
    }
    const specs: WatchSpec[] = []
    try {
      const paginationOpts: Record<string, unknown> = {
        ...sub.pageOpts,
        limit: sub.limit,
        [direction]: cursor,
      }
      const rs = await withTurn(s, slot, async () => handlers._runQuery(sub.name, { ...sub.baseArgs, paginationOpts }, await runContext(s, specs)), true)
      if (!rs?.results) throw new Error("Invalid paginated result")
      if (current(s, slot, sub)) {
        sub.loadedCount += rs.results.length
        if (direction === "next") {
          sub.hasNext = !!rs.hasNext
          sub.nextCursor = rs.hasNext ? rs.next : undefined
        } else {
          sub.hasPrevious = !!rs.hasPrevious
          sub.previousCursor = rs.hasPrevious ? rs.previous : undefined
          // The window now starts with these rows: a re-run reads them back from the cursor
          // that fetched them, then walks forward through the rest.
          if (rs.results.length) sub.start = { previous: cursor, count: rs.results.length }
        }
        // The window grew: the new page's watches join the rest until the next re-run. Not
        // caught up: like a first run, a page's read precedes its watches, and catching it up
        // would re-read the whole window on every page load — quadratic in scroll depth.
        await reconcile(s, slot, sub, specs, "add")
        sub.live = true
      }
      send(s, slot, { type: "PaginatedQueryPage", success: true, direction, data: rs }, rid, sub)
    } catch (error) {
      // Refused (access revoked since the window was read) or failing: fail closed, as a re-run
      // does. The earlier pages' watches stayed open, and every write to them kept producing a
      // frame for a caller who may no longer see the rows.
      if (error === skipped) return
      failRun(s, slot, sub, { type: "PaginatedQueryPage", direction }, error, rid)
    }
  }

  // A change on any of a slot's watches re-runs whatever its subscription is WHEN the re-run
  // starts — never one that has since been replaced, and never one whose requested first run
  // has not completed: that run is queued behind and reads fresh data anyway. Running the new
  // subscription early ran its handler twice, and if the early run failed, its teardown left
  // the requested run answering success with nothing watching — a screen that never updated.
  const rerun = async (s: Socket, slot: Slot, chain: number) => {
    // Queued on a queue the slot's subscription no longer follows (it was replaced, and the
    // replacement stopped waiting for this queue): the replacement's own queue re-runs it.
    if (chain !== slot.chain) return
    const sub = slot.sub
    if (!sub || !current(s, slot, sub) || !sub.live) return
    // A client not reading its frames gets no more until it does: every subscription a change
    // reaches meanwhile is marked, and each re-runs once when the socket drains (reading
    // everything that changed).
    if (s.conn.isBackedUp?.()) {
      slot.dirty = true
      return holdUntilDrained(s)
    }
    const isCatchUp = slot.catchUp
    slot.catchUp = false
    if (sub.kind === "query") await runQuery(s, slot, sub, false, isCatchUp)
    else await refetchPaged(s, slot, sub, isCatchUp)
  }

  // Backed-up sockets, polled by ONE timer for the whole engine — not one per socket, which in a
  // write storm with many stalled clients meant thousands of wakeups a second — until each
  // drains; then each of its marked subscriptions re-runs once, however many changes arrived.
  const backedUp = new Set<Socket>()
  let drainTimer: ReturnType<typeof setInterval> | undefined
  const holdUntilDrained = (s: Socket) => {
    backedUp.add(s)
    if (drainTimer) return
    drainTimer = setInterval(() => {
      for (const sock of backedUp) {
        if (sock.closed) backedUp.delete(sock)
        else if (!sock.conn.isBackedUp?.()) {
          backedUp.delete(sock)
          for (const slot of sock.slots.values()) {
            if (!slot.dirty) continue
            slot.dirty = false
            onEvent(sock, slot)
          }
        }
      }
      if (!backedUp.size) {
        clearInterval(drainTimer)
        drainTimer = undefined
      }
    }, DRAIN_POLL_MS)
    drainTimer.unref?.()
  }

  // A change (or a watch back, or a drained buffer): re-run. Such a run is not a mere catch-up —
  // a catch-up pending when the change arrived is folded into it — so it may schedule a
  // catch-up of its own. Merged into the catch-up instead, a change whose run opened yet another
  // watch had no catch-up for it, and a write between that read and that watch went unseen.
  const onEvent = (s: Socket, slot: Slot) => {
    if (s.closed || !slot.sub || s.slots.get(slot.key) !== slot) return
    slot.catchUp = false
    scheduleRun(s, slot)
  }

  const scheduleRun = (s: Socket, slot: Slot) => {
    if (s.closed || !slot.sub || s.slots.get(slot.key) !== slot) return
    // A slot's re-runs are debounced on their own: one change matching several subscriptions on a
    // socket re-runs each of them once.
    scheduler.schedule(slot.runKey, () => {
      const chain = slot.chain
      return enqueue(s, slot, () => rerun(s, slot, chain))
    })
  }

  // A new subscription replaces the slot's old one at once; the old one's watches stay open until
  // the new one's first run reconciles them, so watches both ask for never close at all.
  const subscribe = (s: Socket, slot: Slot, sub: Sub) => {
    // Replacing: the new subscription's runs follow the replaced one's in the slot's queue — so
    // its first answer comes after the old one's — but wait for it at most turnTimeoutMs. Unbounded,
    // a handler that never settled left every later subscription on the slot unanswered (on main
    // each subscription had a queue of its own). Safe to overlap: a replaced subscription's run
    // no longer touches the slot's watches (it is not current).
    if (slot.sub) {
      slot.queue = waitAtMost(slot.queue, turnTimeoutMs)
      slot.chain++
    }
    sub.gen = ++slot.subGen
    slot.sub = sub
    resetSlotState(slot)
  }

  // `queue`, or its end after `ms` — whichever comes first; settles either way.
  const waitAtMost = (queue: Promise<void>, ms: number): Promise<void> => {
    if (ms > MAX_TIMER_MS) return queue
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
      void queue.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // What a subscription leaves on its slot, forgotten when it ends or is replaced — one list, for
  // subscribe and teardown alike: its pending re-run, catch-up, backpressure mark and retries are
  // not the next one's; nor its watches' backoff, nor its specs (a watch of the old one that died
  // before the new one's first run would otherwise have been reopened under the new one). Its
  // open watches stay: a replacement's first run reconciles them, a teardown closes them.
  const resetSlotState = (slot: Slot) => {
    scheduler.cancel(slot.runKey)
    slot.catchUp = false
    slot.dirty = false
    clearRetries(slot)
    slot.deaths.clear()
    slot.openFailures.clear()
    slot.specs = new Map()
  }

  const closeSocket = async (id: string) => {
    const s = sockets.get(id)
    if (!s) return
    sockets.delete(id)
    s.closed = true
    backedUp.delete(s)
    // Runs waiting for a turn are resumed — each finds the socket closed and skips (withTurn) — so
    // their chains settle. Held, their closures kept the socket alive while the runs holding the
    // turns hung; dropped, their chains never settled, and a waiting re-run's scheduler entry
    // stayed in flight for good.
    for (const resume of [...s.waitingAsked.splice(0), ...s.waiting.splice(0)]) resume()
    const slots = [...s.slots.values()]
    await Promise.all(slots.map((slot) => teardown(s, slot)))
    s.slots.clear()
    s.tails.clear()
  }

  // A new subscription past maxSubscriptionsPerSocket: refused on the frame its request would have
  // got, with `ended: true` for a sid (nothing is subscribed for it) — as endedMark marks it.
  const refuseLimit = (s: Socket, type: string, sid: Sid | undefined, msg: any): true => {
    const error = `Too many subscriptions on this socket (at most ${maxSubscriptions}): unsubscribe one first`
    reply(s, { type: answerTypeOf(type), success: false, error, ...(sid !== undefined ? { ended: true } : {}) }, msg)
    return true
  }

  return {
    open(id, conn) {
      sockets.set(id, { id, conn, closed: false, slots: new Map(), tails: new Map(), running: 0, waitingAsked: [], waiting: [], overtime: 0, lingering: 0 })
    },

    handle(id, msg) {
      const type = msg?.type
      if (!LIVE_TYPES.has(type)) return false
      const s = sockets.get(id)
      if (!s) return true
      const sid = readSid(msg.sid)
      const direction = directionOf(type)
      if (sid === null) {
        reply(s, { type: answerTypeOf(type), success: false, ...(direction ? { direction } : {}), error: "Invalid sid: a string of at most 64 characters, or a finite number" }, msg)
        return true
      }
      if (type === "unsubscribe") {
        // At once: nothing more is sent for it, not even the answer of a run already in flight.
        const slot = slotFor(s, sid, false)
        if (slot) {
          slot.ended = true
          void teardown(s, slot)
        }
        reply(s, { type: "Unsubscribed" }, msg)
        return true
      }
      if (type === "query") {
        const slot = slotFor(s, sid, true)
        if (!slot) return refuseLimit(s, type, sid, msg)
        const sub: QuerySub = { kind: "query", name: msg.name, args: msg.args, rid: readRid(msg.rid) }
        subscribe(s, slot, sub)
        enqueue(s, slot, () => runQuery(s, slot, sub, true))
        return true
      }
      if (type === "paginated-query") {
        const slot = slotFor(s, sid, true)
        if (!slot) return refuseLimit(s, type, sid, msg)
        const args = msg.args
        const paginationOpts = args?.paginationOpts || {}
        const baseArgs = { ...(args || {}) }
        delete baseArgs.paginationOpts
        const asked = pageLimitOf(paginationOpts.limit)
        const sub: PagedSub = {
          kind: "paginated",
          name: msg.name,
          baseArgs,
          rid: readRid(msg.rid),
          limit: asked ?? 10,
          limitAsked: asked !== undefined,
          pageOpts: pageOptsOf(paginationOpts),
          start: startCursorOf(paginationOpts),
          loadedCount: 0,
          hasPrevious: false,
          hasNext: false,
        }
        subscribe(s, slot, sub)
        enqueue(s, slot, () => startPaged(s, slot, sub, args))
        return true
      }
      // paginated-query-load-next / -previous (every other type was answered above): the
      // paginated subscription of `sid`'s slot.
      const loadDirection = direction === "previous" ? "previous" : "next"
      const slot = slotFor(s, sid, false)
      const sub = slot?.sub
      if (!slot || sub?.kind !== "paginated") {
        reply(s, { type: "PaginatedQueryPage", success: false, direction: loadDirection, error: "No active paginated subscription" }, msg)
        return true
      }
      // The rid is this load's own, current from when it runs: set on arrival, a load queued
      // behind another took the later one's rid, and the earlier was never answered with its own.
      const rid = readRid(msg.rid)
      enqueue(s, slot, async () => {
        if (current(s, slot, sub)) {
          if (rid !== undefined) sub.rid = rid
          return loadMore(s, slot, sub, loadDirection)
        }
        // Its sid's subscription ended with `ended: true` while this waited: that frame answered
        // its pending loads too. Refused here, the refusal (with the sid) came after the client
        // had re-subscribed the sid, and looked like the new subscription's.
        if (slot.endedSent) return
        // Replaced (or the default slot torn down) while this waited in the queue: a load the
        // client asked for is still answered, or its loading state never settles.
        // Not checked against answeredGen (no `sub` given): a refusal answers the client's own request.
        send(s, slot, { type: "PaginatedQueryPage", success: false, direction: loadDirection, error: "No active paginated subscription" }, rid ?? sub.rid)
      })
      return true
    },

    close: closeSocket,

    /** Test hook: the socket's own state object. */
    _socket(id: string) {
      return sockets.get(id)
    },

    /** Test hook: the sizes of a socket's per-watch bookkeeping, summed over its subscriptions. */
    _socketState(id: string) {
      const s = sockets.get(id)
      if (!s) return undefined
      const sum = (size: (slot: Slot) => number) => [...s.slots.values()].reduce((n, slot) => n + size(slot), 0)
      return {
        watches: sum((slot) => slot.watches.size),
        specs: sum((slot) => slot.specs.size),
        deaths: sum((slot) => slot.deaths.size),
        openFailures: sum((slot) => slot.openFailures.size),
        retryTimers: sum((slot) => slot.retryTimers.size),
        subscriptions: s.slots.size,
      }
    },

    // A local function, not `this.close`: `const { shutdown } = live` must work too.
    async shutdown() {
      scheduler.cancelAll()
      await Promise.all([...sockets.keys()].map(closeSocket))
    },
  }
}
