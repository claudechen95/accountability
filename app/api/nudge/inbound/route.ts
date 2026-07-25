import { NextResponse } from "next/server";
import {
  findUserByPhone,
  setNudgeSnoozed,
  getGoalStatuses,
  getActiveVacation,
  getTodayDate,
  resolveUser,
} from "@/lib/kv";
import { getPendingNudges } from "@/lib/nudges";

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

  if (body.is_outbound === false && typeof body.number === "string" && typeof body.content === "string") {
    const user = await findUserByPhone(body.number);
    if (user) {
      const uid = resolveUser(user.id);
      const today = getTodayDate();
      const todayDow = new Date(today + "T12:00:00").getDay();

      const vacation = await getActiveVacation(uid);
      const pausedIds = new Set(vacation?.goalIds ?? []);
      const goals = (await getGoalStatuses(uid)).filter((g) => !pausedIds.has(g.id));
      const pending = getPendingNudges(goals, todayDow);

      // Sendblue has no reply-to/thread field, so there's no reliable way to know which
      // outbound message a reply is "about" — match the reply text against pending habit
      // names instead. No match (e.g. a plain "ok"/"stop") falls back to snoozing everything,
      // since that's the safer read of an unattributable reply.
      const reply = body.content.toLowerCase();
      const matched = pending.filter((g) => reply.includes(g.name.toLowerCase()));
      const toSnooze = matched.length > 0 ? matched : pending;

      await Promise.all(toSnooze.map((g) => setNudgeSnoozed(uid, g.id, today)));
    }
  }

  return NextResponse.json({ ok: true });
}
