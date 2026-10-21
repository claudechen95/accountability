import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import { resolveUser, getPushSubscriptions, savePushSubscription, removePushSubscriptions } from "@/lib/kv";
import { isPushConfigured, parsePushSubscription, vapidPublicKey } from "@/lib/push";

// Open in the same way as the rest of the API: there is no auth. The body is not an open relay.
// parsePushSubscription refuses anything that is not a vendor push endpoint.

async function GETHandler(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const subs = await getPushSubscriptions(user);
  return NextResponse.json({
    configured: isPushConfigured(),
    publicKey: vapidPublicKey(),
    endpoints: subs.map((sub) => sub.endpoint),
  });
}

async function POSTHandler(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  let body: { subscription?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  }
  const sub = parsePushSubscription(body?.subscription);
  if (!sub) return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  await savePushSubscription(user, sub);
  return NextResponse.json({ ok: true });
}

async function DELETEHandler(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  let body: { endpoint?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
  }
  if (!body || typeof body.endpoint !== "string" || !body.endpoint) {
    return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
  }
  await removePushSubscriptions(user, [body.endpoint]);
  return NextResponse.json({ ok: true });
}

export const GET = withPerf("GET /api/push", GETHandler);
export const POST = withPerf("POST /api/push", POSTHandler);
export const DELETE = withPerf("DELETE /api/push", DELETEHandler);
