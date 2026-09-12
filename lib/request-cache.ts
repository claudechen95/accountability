/**
 * A read cache scoped to one request.
 *
 * The instrumentation in `lib/perf.ts` found that 42% of the key reads in `GET /api/goals` were
 * for keys the same request had already fetched - `settings:vacation` 26 times, each habit's
 * current-week check-ins three or four times. None of that is a mistake at any single call site:
 * `getStreak`, `getCompletedThisPeriod` and `getReflectionPrompt` are separate functions that
 * each legitimately need the same key, and they're deliberately run concurrently. The
 * duplication only exists when you look at the request as a whole, so that's the level it gets
 * fixed at.
 *
 * The cache stores the **promise**, not the resolved value. That matters: the callers above run
 * inside one `Promise.all`, so they all ask before any answer arrives. A value cache would miss
 * every time and issue every request anyway; a promise cache collapses them into one round trip.
 *
 * Scope is a single request (opened by `withPerf`), so "stale" means "changed by someone else
 * during one request", which this app has no way to care about - and writes invalidate anyway.
 * Outside a request it's a transparent passthrough, so scripts and tests behave normally.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Open a cache scope. Nested calls reuse the outer scope rather than starting a second one. */
export function runWithCache<T>(fn: () => Promise<T>): Promise<T> {
  if (store.getStore()) return fn();
  return store.run(new Map(), fn);
}

/**
 * Read `key` through the cache. On a miss, `load` runs and its promise is cached immediately -
 * before it resolves - so concurrent callers share one round trip.
 *
 * A rejected load is evicted, so a transient failure doesn't poison the rest of the request.
 */
export function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cache = store.getStore();
  if (!cache) return load();
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;
  const pending = load().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, pending);
  return pending as Promise<T>;
}

/** A cached read already in flight or settled, or undefined on a miss. Never starts a read. */
export function peek<T>(key: string): Promise<T> | undefined {
  return store.getStore()?.get(key) as Promise<T> | undefined;
}

/**
 * Record a value fetched some other way - a batched `mget`, a pipeline - so later single-key
 * reads of it are free. This is what lets a batch read and an unbatched one share results.
 */
export function prime<T>(key: string, value: T): void {
  store.getStore()?.set(key, Promise.resolve(value));
}

/**
 * Drop keys from the cache. Every write in `lib/kv.ts` calls this for the keys it touched, so a
 * request that writes and then reads back sees its own write.
 */
export function invalidate(...keys: string[]): void {
  const cache = store.getStore();
  if (!cache) return;
  for (const key of keys) cache.delete(key);
}
