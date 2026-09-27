import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import {
  findUserByPhone,
  setNudgeMuted,
  getNudgeCandidates,
  getTodayDate,
  getPstMinutesNow,
  resolveUser,
} from "@/lib/kv";
import { getPendingNudges, crossesMidnight, nudgeAnchors } from "@/lib/nudges";
import { sendText } from "@/lib/sendblue";

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

async function POSTHandler(req: Request) {
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
      const reply: string = body.content.trim().toLowerCase();

      // The habits that were actually nudging when the reply came in — which is precisely what
      // the reply can be an answer to. Sendblue has no reply-to/thread field, so there is no
      // way to know which outbound message a reply is "about"; the clock is the best available
      // answer, and it's an honest one, because getPendingNudges already gates a habit out
      // until its own nudge time has passed.
      //
      // Both nudge days are considered, exactly as the dispatch tick considers them: just after
      // midnight the text the user is replying to may well have come from a ladder that started
      // yesterday evening, and muting it has to write under *that* day's key or the ladder
      // carries on calling.
      const pending: { date: string; goal: { id: string; emoji: string; name: string } }[] = [];
      for (const a of nudgeAnchors(getPstMinutesNow(), getTodayDate())) {
        const candidates = await getNudgeCandidates(a.date, uid);
        const inPlay = a.carryover ? candidates.filter((g) => crossesMidnight(g.nudgeTime)) : candidates;
        for (const goal of getPendingNudges(inPlay, a.dow, a.nowMin)) pending.push({ date: a.date, goal });
      }

      // Answering mutes those habits for the rest of the day, whatever the answer says. The bar
      // is intentionally low - "ok" clears it - on the view that the escalation exists to reach
      // a person and a reply is proof it did.
      //
      // What it deliberately does NOT do is silence a habit that hasn't started nudging yet.
      // That was the old behaviour (one per-user `replied` flag), and it meant a "pause" sent at
      // noon swallowed a 9pm reminder the user had never been asked about and plainly still
      // wanted. A reply answers the question it was asked, not every question the day might
      // still hold.
      if (reply.length > 0) {
        await Promise.all(pending.map((p) => setNudgeMuted(uid, p.goal.id, p.date)));
      }

      // Confirm back so the reply doesn't just vanish into silence — the user has no other way
      // to know it was understood. The message names exactly what it muted and says outright
      // that later habits are still coming, since "muted for today" on its own reads as a
      // bigger promise than this now makes.
      if (reply.length > 0) {
        const named = pending.map((p) => `${p.goal.emoji} ${p.goal.name}`).join(", ");
        const body_ =
          pending.length > 0
            ? `✅ Got it: ${named}. Muted for the rest of today. Any habit due later today will still nudge you.`
            : `✅ Got it. Nothing's nudging you right now.`;
        try {
          await sendText(body.number, body_);
        } catch (err) {
          console.error(`Nudge reply confirmation failed for ${user.id}:`, err);
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}

export const POST = withPerf("POST /api/nudge/inbound", POSTHandler);
