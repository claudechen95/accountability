/**
 * Client-side half of the latency instrumentation.
 *
 * The server log says how long a route took; this says how long the *user* waited, which is a
 * different number. Every view here is a client component that renders a skeleton and then
 * fetches, so the wait is: document → JS chunks → hydrate → fetch → paint. The server only sees
 * the fourth step. `timedFetch` logs the whole span from the browser's point of view, and reads
 * the `Server-Timing` header back off the response so both halves land on one line:
 *
 *   [perf] client /api/goals 412ms (server 281ms, redis 279ms/135cmd) — 131ms of it not server
 *
 * That trailing figure is the part the server can't see: request queueing, TLS, transfer, and
 * JSON parse. When it's large the fix is on the client; when the server figure is large the fix
 * is in `lib/kv.ts`.
 */

interface ServerTiming {
  total?: number;
  redis?: number;
  redisCmds?: string;
}

function parseServerTiming(header: string | null): ServerTiming {
  if (!header) return {};
  const out: ServerTiming = {};
  for (const entry of header.split(",")) {
    const name = entry.trim().split(";")[0];
    const dur = /dur=([\d.]+)/.exec(entry);
    const desc = /desc="([^"]*)"/.exec(entry);
    if (name === "total" && dur) out.total = Number(dur[1]);
    if (name === "redis") {
      if (dur) out.redis = Number(dur[1]);
      if (desc) out.redisCmds = desc[1];
    }
  }
  return out;
}

/**
 * `fetch`, plus a timing line. Drop-in: same arguments, same return value, and a failed request
 * still throws exactly as `fetch` would - the log line is the only addition.
 */
export async function timedFetch(input: string, init?: RequestInit): Promise<Response> {
  const t0 = performance.now();
  try {
    const res = await fetch(input, init);
    const elapsed = performance.now() - t0;
    const st = parseServerTiming(res.headers.get("Server-Timing"));
    const method = init?.method ?? "GET";
    const path = input.split("?")[0];
    const parts = [`${method} ${path} ${elapsed.toFixed(0)}ms`];
    if (st.total !== undefined) {
      parts.push(`server ${st.total.toFixed(0)}ms`);
      if (st.redis !== undefined) parts.push(`redis ${st.redis.toFixed(0)}ms/${st.redisCmds ?? "?"}`);
      parts.push(`network+parse ${(elapsed - st.total).toFixed(0)}ms`);
    }
    console.log(`[perf] client ${parts.join(" · ")}`);
    return res;
  } catch (err) {
    console.log(`[perf] client ${init?.method ?? "GET"} ${input.split("?")[0]} failed after ${(performance.now() - t0).toFixed(0)}ms`);
    throw err;
  }
}

/**
 * How long the user actually waited for a view's first real content: navigation start to the
 * moment the view has data. Call it once, when the initial load resolves.
 *
 * This is the number that matters and the one no server log contains - it includes the JS
 * download and hydration that has to finish before the first fetch is even issued.
 */
export function logFirstData(view: string): void {
  if (typeof performance === "undefined") return;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const sinceNav = performance.now();
  const hydrated = nav ? nav.domContentLoadedEventEnd : 0;
  console.log(
    `[perf] client ${view} first data at ${sinceNav.toFixed(0)}ms after navigation` +
      (hydrated ? ` (DOM ready at ${hydrated.toFixed(0)}ms, so ${(sinceNav - hydrated).toFixed(0)}ms was the fetch)` : "")
  );
}
