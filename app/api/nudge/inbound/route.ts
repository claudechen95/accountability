import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import {
  findUserByPhone,
  setNudgeSnoozedUntil,
  getNudgeCandidates,
  getTodayDate,
  getPstMinutesNow,
  resolveUser,
} from "@/lib/kv";
import { getPendingNudges, crossesMidnight, nudgeAnchors } from "@/lib/nudges";
import {
  SNOOZE_HINT,
  parseSnoozeReply,
  soonestUntil,
  formatSnoozeWhen,
  snoozeHold,
  snoozeConfirmation,
} from "@/lib/snooze";
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
      const reply = body.content.trim();
      // An empty webhook body is not an answer.
      if (reply.length > 0) {
        // The habits that were actually nudging when the reply came in. Sendblue has no
        // reply-to/thread field, so the clock is the best available answer, and it's an honest
        // one: getPendingNudges already gates a habit out until its own nudge time has passed.
        // A number whose habit hasn't started yet is left alone. A noon reply used to silence a
        // 9pm reminder the user had never been asked about.
        //
        // Both nudge days are considered, exactly as the dispatch tick considers them: just
        // after midnight the text being answered may belong to a ladder that started yesterday
        // evening, and the hold has to be written under that day's key or the ladder carries on.
        const wallNow = getPstMinutesNow();
        const pending: {
          date: string;
          carryover: boolean;
          goal: { id: string; emoji: string; name: string; nudgeNumber?: number; nudgeTime?: string };
        }[] = [];
        for (const a of nudgeAnchors(wallNow, getTodayDate())) {
          const candidates = await getNudgeCandidates(a.date, uid);
          const inPlay = a.carryover ? candidates.filter((g) => crossesMidnight(g.nudgeTime)) : candidates;
          for (const goal of getPendingNudges(inPlay, a.dow, a.nowMin)) {
            pending.push({ date: a.date, carryover: a.carryover, goal });
          }
        }

        // Only the instructed shape does anything. "pause" and "ok" used to mute every habit
        // that was nudging, for the rest of the day; they now get the instructions back and
        // the ladder keeps going.
        const groups = parseSnoozeReply(reply);
        let body_: string;
        if (!groups) {
          body_ = pending.length > 0 ? SNOOZE_HINT : `Nothing's nudging you right now. ${SNOOZE_HINT}`;
        } else {
          const applied = new Map<string, { label: string; when: string; capped: boolean }>();
          const tooLate = new Map<string, string>();
          const missed = new Set<number>();
          const matched = new Set<number>();
          for (const group of groups) {
            const wallUntil = soonestUntil(group.clockMins, wallNow);
            for (const n of group.numbers) {
              const hits = pending.filter((p) => p.goal.nudgeNumber === n);
              if (hits.length === 0) {
                missed.add(n);
                continue;
              }
              // The habit is nudging and was named, so the reply was about it - whether or not
              // there turns out to be room left to hold it.
              matched.add(n);
              for (const hit of hits) {
                const key = `${hit.date}:${hit.goal.id}`;
                const label = `${hit.goal.emoji} ${hit.goal.name}`;
                // Clamped per habit, since how late a hold can run depends on how late that
                // habit's own ladder reaches.
                const hold = snoozeHold(wallUntil, wallNow, hit.carryover, hit.goal.nudgeTime);
                if (!hold) {
                  tooLate.set(key, label);
                  continue;
                }
                await setNudgeSnoozedUntil(uid, hit.goal.id, hit.date, hold.until);
                applied.set(key, {
                  label,
                  when: formatSnoozeWhen(hold.wall),
                  capped: hold.capped,
                });
              }
            }
          }
          const missedNumbers = Array.from(missed).filter((n) => !matched.has(n));
          const leftOut = pending.some((p) => !applied.has(`${p.date}:${p.goal.id}`));
          body_ = snoozeConfirmation({
            applied: Array.from(applied.values()),
            tooLate: Array.from(tooLate.values()),
            missedNumbers,
            leftOut,
          });
        }

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
