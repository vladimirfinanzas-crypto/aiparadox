// A small fixed-window throttle for endpoints that create rows from an
// unauthenticated caller (the Desktop Agent's pairing codes are the first one).
//
// It keeps at most `maxEntries` keys: past that, expired keys are dropped and,
// if the map is still full, the oldest key goes. An in-process Map that only
// ever grows would be a memory leak on a long-running server — the limit is the
// point of this module, not an optimisation.
//
// This is a per-instance guard, not a shared rate limiter: on a platform that
// runs several instances, each one throttles only its own traffic. Anything that
// must be enforced globally belongs in the database or an upstream limiter.

export type Throttle = {
  /** true when this key may proceed; the call itself counts as a hit. */
  allow(key: string): boolean
  /** Current number of tracked keys (exposed for tests and diagnostics). */
  size(): number
}

export function createThrottle({
  windowMs,
  maxEntries = 1_000,
}: {
  windowMs: number
  maxEntries?: number
}): Throttle {
  const seen = new Map<string, number>()

  function prune(now: number) {
    for (const [key, at] of seen) {
      if (now - at >= windowMs) seen.delete(key)
      else break // insertion order: the first live entry ends the expired run
    }

    // Still full of live keys: forget the oldest one. It is the entry closest to
    // expiring anyway, so the loosest possible consequence of the cap.
    while (seen.size >= maxEntries) {
      const oldest = seen.keys().next()
      if (oldest.done) break
      seen.delete(oldest.value)
    }
  }

  return {
    allow(key) {
      const now = Date.now()
      const last = seen.get(key)
      if (last !== undefined && now - last < windowMs) return false

      if (seen.size >= maxEntries) prune(now)

      // Re-inserting moves the key to the end, so the map stays ordered by use
      seen.delete(key)
      seen.set(key, now)
      return true
    },
    size() {
      return seen.size
    },
  }
}
