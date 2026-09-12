/**
 * Request-scoped latency instrumentation.
 *
 * Every page load here is a handful of API calls, and every API call is some number of Upstash
 * REST round trips. Upstash has no connection - each command is its own HTTPS request - so the
 * thing that decides whether a page feels instant or sluggish is almost entirely *how many
 * commands* a request issues and how many of them are sequential. That number is invisible in
 * the code (it's buried in loops inside `lib/kv.ts`), so it gets counted here instead.
 *
 * Three pieces:
 *   - `instrumentRedis` wraps the client so every command is counted and timed.
 *   - `span` times a named block of work, so a route can be attributed to its parts.
 *   - `withPerf` wraps a route handler: it opens the request-scoped collector, logs one line
 *     when the handler returns, and attaches `Server-Timing` so the same numbers show up in the
 *     browser's network panel next to the request that caused them. It also opens the read cache
 *     from `lib/request-cache.ts` - one wrapper per route establishes the whole request scope.
 *
 * Overhead is a counter increment and a `performance.now()` per command. Collection is always
 * on; `PERF_VERBOSE=1` adds the per-call breakdown to the log line.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { runWithCache } from "./request-cache";

interface Tally {
  count: number;
  ms: number;
}

interface Collector {
  label: string;
  start: number;
  /** Per Redis command name, e.g. `get` → 91 calls / 1600ms. */
  cmds: Map<string, Tally>;
  /** Named spans opened by `span()`. */
  spans: Map<string, Tally>;
  /** Total commands issued, across every command name. */
  redisCalls: number;
  /**
   * Summed command time. Exceeds wall-clock when commands run concurrently, which is the point:
   * comparing this to elapsed time says whether the round trips were batched or serialized.
   */
  redisMs: number;
  /** Wall-clock time with at least one command in flight - the request's real Redis cost. */
  blockedMs: number;
  inFlight: number;
  windowStart: number;
  /** Keys already read once in this request, and how many times each was re-read. */
  keysRead: Map<string, number>;
  repeatReads: number;
}

const store = new AsyncLocalStorage<Collector>();

function tally(map: Map<string, Tally>, name: string, ms: number): void {
  const entry = map.get(name);
  if (entry) {
    entry.count += 1;
    entry.ms += ms;
  } else {
    map.set(name, { count: 1, ms });
  }
}

function record(collector: Collector, name: string, ms: number): void {
  tally(collector.cmds, name, ms);
  collector.redisCalls += 1;
  collector.redisMs += ms;
  // Union of the in-flight windows: how much of the request was spent waiting on Redis at all,
  // as opposed to the sum of the waits. With perfect batching these converge on one round trip;
  // with a sequential loop they converge on the sum.
  collector.inFlight -= 1;
  if (collector.inFlight === 0) {
    collector.blockedMs += performance.now() - collector.windowStart;
  }
}

/**
 * Wrap a Redis client so every command that returns a promise is counted against the current
 * request. Outside a request (scripts, module init) it's a passthrough.
 */
export function instrumentRedis<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        const collector = store.getStore();
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!collector) return result;
        // A pipeline is an object that batches commands and sends them on `exec()` - one round
        // trip for the lot, which is the whole reason to use one. Count it that way.
        if (prop === "pipeline" || prop === "multi") return wrapPipeline(collector, result);
        if (!isPromise(result)) return result;

        // `mget a b c` is one round trip for three keys - worth distinguishing from three gets.
        const name = args.length > 1 && (prop === "mget" || prop === "del") ? `${prop}(${args.length})` : prop;
        if (READS.has(prop)) noteKeys(collector, args);
        const t0 = performance.now();
        if (collector.inFlight === 0) collector.windowStart = t0;
        collector.inFlight += 1;
        return result.then(
          (ok) => {
            record(collector, name, performance.now() - t0);
            return ok;
          },
          (err) => {
            record(collector, `${name}:error`, performance.now() - t0);
            throw err;
          }
        );
      };
    },
  }) as T;
}

/**
 * Count a pipeline as the single round trip it is, labelled with how many commands it carried.
 * Read keys queued on it still register, so the re-read detector keeps working across batches.
 */
function wrapPipeline(collector: Collector, pipeline: unknown): unknown {
  let queued = 0;
  return new Proxy(pipeline as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (prop === "exec") {
        return (...args: unknown[]) => {
          const n = queued;
          const t0 = performance.now();
          if (collector.inFlight === 0) collector.windowStart = t0;
          collector.inFlight += 1;
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args).then(
            (ok) => {
              record(collector, `pipeline(${n})`, performance.now() - t0);
              return ok;
            },
            (err) => {
              record(collector, `pipeline(${n}):error`, performance.now() - t0);
              throw err;
            }
          );
        };
      }
      return (...args: unknown[]) => {
        queued += 1;
        if (READS.has(prop)) noteKeys(collector, args);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function isPromise(v: unknown): v is Promise<unknown> {
  return typeof (v as { then?: unknown } | null)?.then === "function";
}

/** Commands whose leading args are keys being *read*. A re-read inside one request is waste. */
const READS = new Set(["get", "mget", "lrange", "llen", "hget", "hgetall", "smembers"]);

function noteKeys(collector: Collector, args: unknown[]): void {
  for (const arg of args) {
    if (typeof arg !== "string") break; // lrange's trailing indices - stop at the first non-key
    const seen = collector.keysRead.get(arg) ?? 0;
    collector.keysRead.set(arg, seen + 1);
    if (seen > 0) collector.repeatReads += 1;
  }
}

/**
 * Time a named block. Spans nest and may run concurrently, so summed span time can exceed the
 * request's wall clock - the count and the per-span total are what matter.
 */
export async function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const collector = store.getStore();
  if (!collector) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    tally(collector.spans, name, performance.now() - t0);
  }
}

function sortedTallies(map: Map<string, Tally>): string[] {
  const out: { name: string; t: Tally }[] = [];
  map.forEach((t, name) => out.push({ name, t }));
  return out
    .sort((a, b) => b.t.ms - a.t.ms)
    .map(({ name, t }) => `${name}x${t.count} ${t.ms.toFixed(0)}ms`);
}

function format(collector: Collector, totalMs: number): string {
  const parts = [
    `${collector.label} ${totalMs.toFixed(0)}ms`,
    `redis=${collector.redisCalls}cmd/${collector.blockedMs.toFixed(0)}ms`,
    `keys=${collector.keysRead.size}uniq/${collector.repeatReads}repeat`,
  ];
  if (process.env.PERF_VERBOSE === "1") {
    const cmds = sortedTallies(collector.cmds);
    const spans = sortedTallies(collector.spans);
    if (spans.length) parts.push(`spans: ${spans.join(" · ")}`);
    if (cmds.length) parts.push(`cmds: ${cmds.join(" · ")}`);
    // Only the worst offenders: a request re-reading 200 date keys twice each is one bug
    // (two overlapping range scans), and printing all 200 buries it.
    const hot: { key: string; n: number }[] = [];
    collector.keysRead.forEach((n, key) => {
      if (n > 1) hot.push({ key, n });
    });
    if (hot.length) {
      const top = hot.sort((a, b) => b.n - a.n).slice(0, 6);
      const rest = hot.length - top.length;
      parts.push(
        `re-read: ${top.map(({ key, n }) => `${key}x${n}`).join(" · ")}${rest > 0 ? ` · +${rest} more keys` : ""}`
      );
    }
  }
  return `[perf] ${parts.join(" | ")}`;
}

function serverTiming(collector: Collector, totalMs: number): string {
  const entries = [
    `total;dur=${totalMs.toFixed(1)}`,
    `redis;desc="${collector.redisCalls} cmds";dur=${collector.blockedMs.toFixed(1)}`,
  ];
  collector.spans.forEach((t, name) => {
    entries.push(`${name.replace(/[^\w]/g, "_")};desc="x${t.count}";dur=${t.ms.toFixed(1)}`);
  });
  return entries.join(", ");
}

/**
 * Wrap a route handler so its Redis traffic is counted and reported. Returns a handler with the
 * same signature, so a route only has to change its export:
 *
 *     export const GET = withPerf("GET /api/goals", async (req) => { ... });
 */
export function withPerf<A extends unknown[]>(
  label: string,
  handler: (...args: A) => Promise<Response>
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const collector: Collector = {
      label,
      start: performance.now(),
      cmds: new Map(),
      spans: new Map(),
      redisCalls: 0,
      redisMs: 0,
      blockedMs: 0,
      inFlight: 0,
      windowStart: 0,
      keysRead: new Map(),
      repeatReads: 0,
    };
    return store.run(collector, () =>
      runWithCache(async () => {
        const res = await handler(...args);
        const totalMs = performance.now() - collector.start;
        console.log(format(collector, totalMs));
        try {
          res.headers.set("Server-Timing", serverTiming(collector, totalMs));
        } catch {
          // Immutable headers on some response types - the log line still carries the numbers.
        }
        return res;
      })
    );
  };
}

/** Same as `withPerf`, for server components and scripts, which return data rather than a Response. */
export async function measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const collector: Collector = {
    label,
    start: performance.now(),
    cmds: new Map(),
    spans: new Map(),
    redisCalls: 0,
    redisMs: 0,
    blockedMs: 0,
    inFlight: 0,
    windowStart: 0,
    keysRead: new Map(),
    repeatReads: 0,
  };
  return store.run(collector, () =>
    runWithCache(async () => {
      const result = await fn();
      console.log(format(collector, performance.now() - collector.start));
      return result;
    })
  );
}
