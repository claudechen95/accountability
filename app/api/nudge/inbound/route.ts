import { NextResponse } from "next/server";
import { findUserByPhone, setNudgeSnoozed, getTodayDate, resolveUser } from "@/lib/kv";

// Sendblue's inbound-message webhook target, registered via POST /api/account/webhooks with
// our own chosen secret (see CLAUDE.md). Sendblue's docs confirm the secret is echoed back in
// a request header but don't name it exactly, so we check the header first and fall back to a
// `secret` field in the JSON body — whichever Sendblue actually uses, an unverified request
// (missing/mismatched on both) is rejected. There is no code path that trusts an unverified
// payload.
function extractSecret(req: Request, body: Record<string, unknown>): string | null {
  return (
    req.headers.get("sb-webhook-secret") ??
    req.headers.get("sb-signing-secret") ??
    (typeof body.secret === "string" ? body.secret : null)
  );
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const secret = extractSecret(req, body);
  if (!secret || secret !== process.env.SENDBLUE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (body.is_outbound === false && typeof body.number === "string") {
    const user = await findUserByPhone(body.number);
    if (user) await setNudgeSnoozed(resolveUser(user.id), getTodayDate());
  }

  return NextResponse.json({ ok: true });
}
