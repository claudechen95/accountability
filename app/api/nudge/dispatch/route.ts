import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import {
  getUsers,
  getNudgeCandidates,
  isNudgeMuted,
  setNudgeMuted,
  getNudgeSnoozedUntil,
  claimNudgeSlot,
  claimEscalation,
  getEscalationTime,
  claimPartnerAlert,
  claimCallAttempt,
  recordCallSid,
  getCallAttempts,
  getTodayDate,
  getPstMinutesNow,
  resolveUser,
  getPushSubscriptions,
  removePushSubscriptions,
  type UserRecord,
} from "@/lib/kv";
import {
  getPendingNudges,
  habitCallStart,
  nudgeSlots,
  dueSlotIndices,
  callScript,
  nextCallTime,
  crossesMidnight,
  partnerAlertAt,
  nudgeAnchors,
  MAX_CALL_ATTEMPTS,
  PARTNER_ALERT_DELAY_MIN,
  type NudgeAnchor,
} from "@/lib/nudges";
import { REPLY_HINT } from "@/lib/snooze";
import { sendText } from "@/lib/sendblue";
import { isCallConfigured, placeCall, getCallOutcome } from "@/lib/call";
import { isPushConfigured } from "@/lib/push";
import { sendPushToAll } from "@/lib/web-push";

type Step = "text" | "call" | "reached" | "partner" | "push";

// The notification carries the habit lines only. The text-reply instructions name "pause", and a
// notification has no reply channel, so that sentence stays on the SMS.
async function sendReminderPush(user: UserRecord, list: string): Promise<boolean> {
  if (!isPushConfigured()) return false;
  const uid = resolveUser(user.id);
  const subs = await getPushSubscriptions(uid);
  if (subs.length === 0) return false;
  const { sent, gone } = await sendPushToAll(subs, { title: "Still pending", body: list, url: `/${user.id}` });
  if (gone.length) {
    try {
      await removePushSubscriptions(uid, gone);
    } catch (err) {
      console.error("Dropping a dead push subscription failed:", err instanceof Error ? err.message : "unknown");
    }
  }
  return sent;
}

/**
 * Runs the whole five-step ladder for one user against one nudge day, and reports which steps
 * actually fired. Both anchors go through here unchanged: an overnight ladder isn't a special
 * case with its own rules, it's the same ladder being asked about a day that started yesterday.
 */
async function runLadder(user: UserRecord, anchor: NudgeAnchor): Promise<Step[]> {
  const uid = resolveUser(user.id);
  const { date, dow, nowMin, carryover } = anchor;
  const steps: Step[] = [];

  const candidates = await getNudgeCandidates(date, uid);
  // The carryover pass still sees every unfinished habit. The "didn't finish today" text waits
  // for midnight, and this is the pass that can send it. Texts and new calls do not: replaying
  // them here would resend the whole evening. `ladderStillRunning` is that split.
  if (candidates.length === 0) return steps;
  const ladderStillRunning = (g: { nudgeTime?: string; nudgeIntervalMin?: number | null }) =>
    !carryover || crossesMidnight(g.nudgeTime, g.nudgeIntervalMin);

  // A habit the user has already answered about is out of the ladder entirely - no texts, no
  // calls, and no place in the partner alert (see isNudgeMuted). Filtered here, once, so every
  // step below works off a single list of habits that are genuinely still outstanding.
  const due = getPendingNudges(candidates, dow, nowMin);
  const mutedFlags = await Promise.all(due.map((g) => isNudgeMuted(uid, g.id, date)));
  const pending = due.filter((_, i) => !mutedFlags[i]);
  if (pending.length === 0) return steps;

  // A snooze holds a habit until the minute the reply named, then the ladder carries on. While
  // the hold is in effect the habit is out of this tick's texts and calls, and it keeps the
  // partner alert waiting (attemptsRemain, below). Text slots that pass during the hold are
  // claimed anyway: dueSlotIndices would otherwise replay every one of them on the tick the
  // hold ends, which is a burst of reminders the user asked not to get.
  const snoozeUntils = await Promise.all(pending.map((g) => getNudgeSnoozedUntil(uid, g.id, date)));
  const active: typeof pending = [];
  let held = false;
  for (let i = 0; i < pending.length; i++) {
    const until = snoozeUntils[i];
    if (until != null && nowMin < until) {
      held = true;
      const indices = dueSlotIndices(nudgeSlots(pending[i].nudgeTime, pending[i].nudgeIntervalMin), nowMin);
      await Promise.all(indices.map((slot) => claimNudgeSlot(uid, pending[i].id, date, slot)));
    } else {
      active.push(pending[i]);
    }
  }

  // Steps 1–3. A habit joins this tick's text only if it actually claimed a slot, so a reminder
  // goes out once per slot rather than once per tick. Texts and calls are both scheduled per
  // habit and don't exclude each other: a habit that starts nudging late can be sending its
  // first text on the same tick another habit is being called about.
  const dueTexts: typeof active = [];
  for (const g of active) {
    if (!ladderStillRunning(g)) continue;
    const indices = dueSlotIndices(nudgeSlots(g.nudgeTime, g.nudgeIntervalMin), nowMin);
    const claims = await Promise.all(indices.map((i) => claimNudgeSlot(uid, g.id, date, i)));
    if (claims.some(Boolean)) dueTexts.push(g);
  }

  if (dueTexts.length > 0) {
    const list = dueTexts.map((g) => `${g.nudgeNumber}. ${g.emoji} ${g.name}`).join("\n");
    // Push first. A Sendblue failure still aborts the calls below, and the notification has
    // already gone out for the slot this tick claimed.
    if (await sendReminderPush(user, list)) steps.push("push");
    if (user.phone) {
      // Names the reply shapes rather than inviting a free-form answer. Sendblue auto-detects
      // stop/unsubscribe/cancel/opt out/revoke/end/quit and the carrier intercepts them ahead of
      // Sendblue on SMS: any of those permanently blocks every future message to this number,
      // transactional included, and never delivers the inbound webhook - so the ladder would keep
      // calling and alerting the partner about texts that can no longer arrive. Offering "done"
      // and "pause" is part of that defence: a user who finished the habit, or who means to skip
      // today, needs a word for it, or they improvise one, and the words people improvise are
      // exactly the reserved ones.
      await sendText(user.phone, `⏰ Still pending:\n${list}\n${REPLY_HINT}`);
      steps.push("text");
    }
  }

  // Calls and the partner text need a number. A subscription on its own still received the
  // reminders above, and nothing past here can be delivered without a phone.
  if (!user.phone) return steps;

  // Step 4, one ladder per habit, each hanging off its own last text. Resolving the previous
  // attempt happens before any new one is claimed, so "keep calling" is driven by what actually
  // happened rather than by the clock alone.
  const callable = isCallConfigured();
  const dueCalls: { goal: (typeof pending)[number]; attempt: number }[] = [];
  const reachedIds: string[] = [];
  // A held habit still has its ladder ahead of it, so the partner alert waits with it.
  let attemptsRemain = held;
  let lastAttemptAt: number | null = null;

  // Habits due on the same tick share one placed call and therefore one sid, so asking Twilio
  // about each of them separately would poll the same call several times per tick.
  const outcomes = new Map<string, Awaited<ReturnType<typeof getCallOutcome>>>();
  const outcomeOf = async (sid: string) => {
    if (!outcomes.has(sid)) outcomes.set(sid, await getCallOutcome(sid));
    return outcomes.get(sid)!;
  };

  for (const g of active) {
    const open = ladderStillRunning(g);
    const start = habitCallStart(g.nudgeTime, g.nudgeIntervalMin);
    if (open && nowMin < start) {
      attemptsRemain = true; // its texts are still running
      continue;
    }
    // A closed ladder already claimed this in the evening. Claiming it again after midnight
    // would stamp "now" over the real time and pull the partner text off the evening's clock.
    if (open) await claimEscalation(uid, date, nowMin);
    if (open && !callable) continue;

    const attempts = await getCallAttempts(uid, g.id, date, MAX_CALL_ATTEMPTS);
    const last = attempts[attempts.length - 1];
    if (last && (lastAttemptAt == null || last.at > lastAttemptAt)) lastAttemptAt = last.at;

    if (last?.sid) {
      const outcome = await outcomeOf(last.sid);
      // Picking up mutes the habits that call was about, and only those - a merged call names
      // several, so answering it settles all of them at once. A habit whose own ladder hasn't
      // rung yet is not something the user acknowledged by answering this one.
      if (outcome === "reached") {
        reachedIds.push(g.id);
        continue;
      }
      if (outcome === "pending") {
        attemptsRemain = true; // still ringing; decide on the next tick
        continue;
      }
    }

    // The evening is over. Do not start a new call at 12:10 for a ladder that finished at 10.
    if (!open) continue;

    const nextAt = nextCallTime(attempts.length, last?.at ?? null, start);
    if (nextAt == null) continue; // this habit's attempts are spent
    attemptsRemain = true;
    if (nowMin >= nextAt) dueCalls.push({ goal: g, attempt: attempts.length });
  }

  // Settle the answered habits before dialling anything else this tick: whoever just hung up
  // shouldn't have the phone ring again in the same minute for an unrelated habit. Anything
  // still outstanding picks its ladder back up on the next tick.
  if (reachedIds.length > 0) {
    await Promise.all(reachedIds.map((id) => setNudgeMuted(uid, id, date)));
    steps.push("reached");
    return steps;
  }

  // Habits due on the same tick share a single call rather than dialling the same number twice
  // over - the second would land on a busy signal, and one call naming both is what the user
  // would want anyway.
  if (dueCalls.length > 0) {
    const claimed = [];
    for (const { goal, attempt } of dueCalls) {
      if (await claimCallAttempt(uid, goal.id, date, attempt, nowMin)) {
        claimed.push({ goal, attempt });
      }
    }
    if (claimed.length > 0) {
      const sid = await placeCall(user.phone!, callScript(user.label, claimed.map((c) => c.goal.name)));
      await Promise.all(
        claimed.map((c) => recordCallSid(uid, c.goal.id, date, c.attempt, nowMin, sid))
      );
      steps.push("call");
    }
    return steps;
  }

  // Step 5, once no habit has a call attempt left. The text says the day was missed, so an
  // afternoon or evening time waits for midnight (`partnerAlertAt`). A check-in before that
  // tick removes the habit from `active` and the text never goes out. The countdown still runs
  // from the last attempt placed, falling back to the escalation time when nothing was dialled.
  if (attemptsRemain) return steps;
  const base = lastAttemptAt ?? (await getEscalationTime(uid, date));
  if (base != null && nowMin >= partnerAlertAt(base + PARTNER_ALERT_DELAY_MIN)) {
    if (user.partnerPhone && (await claimPartnerAlert(uid, date))) {
      // Muted habits are already out of `pending`, so the alert names only what the user never
      // answered about - answering is a full exit, not a mute on your own phone.
      const names = active.map((g) => `${g.emoji} ${g.name}`).join(", ");
      await sendText(user.partnerPhone, `📢 ${user.label} didn't finish today: ${names}`);
      steps.push("partner");
    }
  }

  return steps;
}

// Triggered every 10 minutes by an external cron-job.org schedule (see CLAUDE.md). The window
// has to cover every hour a ladder can run in, which since habits may be configured past 22:00
// means round the clock rather than the 8am–11pm it used to be: a 23:30 habit's third text lands
// at 00:10 and its partner alert at 01:10.
//
// Secured with a plain shared secret rather than a signing scheme since the caller is a plain
// HTTP cron service, not a webhook provider with its own verification SDK.
//
// The tick rate deliberately carries no meaning: what fires is decided by each habit's own slot
// times (lib/nudges.ts), so the ladder is identical whether the cron runs every 10 minutes or
// every 5. Ticking at least as often as the tightest slot spacing (MIN_SLOT_GAP_MIN) is the only
// real requirement.
async function POSTHandler(req: Request) {
  if (req.headers.get("x-nudge-secret") !== process.env.NUDGE_DISPATCH_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const anchors = nudgeAnchors(getPstMinutesNow(), getTodayDate());
  const results: { userId: string; step: Step }[] = [];

  // No VAPID keys: phoneless users stay out entirely, so a tick does not claim their slots.
  // A phone user is unchanged when push is off.
  const pushOn = isPushConfigured();
  for (const user of await getUsers()) {
    if (!user.phone) {
      if (!pushOn) continue;
      if ((await getPushSubscriptions(resolveUser(user.id))).length === 0) continue;
    }
    try {
      for (const anchor of anchors) {
        const steps = await runLadder(user, anchor);
        results.push(...steps.map((step) => ({ userId: user.id, step })));
      }
    } catch (err) {
      console.error(`Nudge dispatch failed for ${user.id}:`, err);
      // Don't let one user's failure abort the whole batch.
    }
  }

  return NextResponse.json({ results });
}

export const POST = withPerf("POST /api/nudge/dispatch", POSTHandler);
