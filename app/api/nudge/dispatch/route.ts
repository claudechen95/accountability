import { NextResponse } from "next/server";
import {
  getUsers,
  getGoalStatuses,
  getActiveVacation,
  getNudgeSnoozed,
  claimNudgeSlot,
  getTodayDate,
  resolveUser,
} from "@/lib/kv";
import { getPendingNudges } from "@/lib/nudges";
import { sendText } from "@/lib/sendblue";

// Triggered hourly by an external cron-job.org schedule (see CLAUDE.md for setup). Secured
// with a plain shared secret rather than a signing scheme since the caller is a plain HTTP
// cron service, not a webhook provider with its own verification SDK.
export async function POST(req: Request) {
  if (req.headers.get("x-nudge-secret") !== process.env.NUDGE_DISPATCH_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = getTodayDate();
  const todayDow = new Date(today + "T12:00:00").getDay();
  const pstHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hour12: false,
    }).format()
  );

  const results: { userId: string; nudged: boolean }[] = [];

  for (const user of await getUsers()) {
    if (!user.phone) continue;
    const uid = resolveUser(user.id);

    try {
      // Claim this hour's slot BEFORE sending so an overlapping/retried invocation for the
      // same hour can't pass the same check twice (see lib/kv.ts claimNudgeSlot).
      if (!(await claimNudgeSlot(uid, today, pstHour))) continue;

      const vacation = await getActiveVacation(uid);
      const pausedIds = new Set(vacation?.goalIds ?? []);
      const goals = (await getGoalStatuses(uid)).filter((g) => !pausedIds.has(g.id));
      const pendingAll = getPendingNudges(goals, todayDow);
      const snoozedFlags = await Promise.all(pendingAll.map((g) => getNudgeSnoozed(uid, g.id, today)));
      const pending = pendingAll.filter((_, i) => !snoozedFlags[i]);
      if (pending.length === 0) continue;

      const list = pending.map((g) => `${g.emoji} ${g.name}`).join(", ");
      await sendText(
        user.phone,
        `⏰ Still pending: ${list}. Reply with a habit's name to snooze just that one for today (or anything else to snooze all).`
      );
      results.push({ userId: user.id, nudged: true });
    } catch (err) {
      console.error(`Nudge dispatch failed for ${user.id}:`, err);
      // Don't let one user's failure abort the whole batch.
    }
  }

  return NextResponse.json({ results });
}
