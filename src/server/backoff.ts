// The retry backoff shared by the live-query engine (watch retries), the stream hub (reconnects
// and reopens) and sync streams of their own. One copy, so a fix reaches all three: they had
// drifted (one never forgot old failures after a long healthy run).

/** The longest any of them waits between attempts. */
export const BACKOFF_MAX_MS = 30_000

/** A stream or watch that ran this long had recovered: its earlier failures stop counting. */
export const STABLE_LIFE_MS = 60_000

/** The wait before attempt `n` (1-based count of failures so far): `base`, doubling, capped at `max`. */
export function backoffDelay(n: number, base = 1_000, max = BACKOFF_MAX_MS): number {
  return Math.min(max, base * 2 ** Math.max(0, n - 1))
}
