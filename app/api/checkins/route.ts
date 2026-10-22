import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import {
  addCheckIn,
  undoCheckIn,
  getGoals,
  getUsers,
  resolveUser,
  getNtfyTopic,
  findUserByPhone,
  getPushSubscriptions,
  removePushSubscriptions,
  GraduatedGoalError,
} from "@/lib/kv";
import { checkinPushTag, isPushConfigured } from "@/lib/push";
import { sendPushToAll } from "@/lib/web-push";
import type { Goal } from "@/lib/types";

// A morning check-in is still news that evening. A reminder expires in an hour because
// yesterday's list is not.
const CHECKIN_PUSH_TTL_SECONDS = 12 * 60 * 60;

// The partner is whoever hears about a missed day: the user whose phone is `partnerPhone`.
// Their installed app is where a check-in shows up. Returns whether a device accepted it.
async function pushCheckInToPartner(goal: Goal, userId?: string): Promise<boolean> {
  if (!isPushConfigured()) return false;
  const users = await getUsers();
  const checker = users.find((user) => user.id === (userId ?? "alan"));
  if (!checker?.partnerPhone) return false;
  const partner = await findUserByPhone(checker.partnerPhone);
  // A number that points at yourself isn't a partner, and would otherwise announce your own tap.
  if (!partner || resolveUser(partner.id) === userId) return false;

  const partnerId = resolveUser(partner.id);
  const subs = await getPushSubscriptions(partnerId);
  if (subs.length === 0) return false;

  const tag = checkinPushTag(goal.id);
  const { sent, gone } = await sendPushToAll(
    subs,
    {
      title: `${checker.label} checked in`,
      body: `${goal.emoji} ${goal.name}`,
      url: `/${checker.id}`,
      tag,
      renotify: true,
    },
    { topic: tag, ttlSeconds: CHECKIN_PUSH_TTL_SECONDS },
  );
  if (gone.length) {
    try {
      await removePushSubscriptions(partnerId, gone);
    } catch (err) {
      console.error("Dropping a dead push subscription failed:", err instanceof Error ? err.message : "unknown");
    }
  }
  return sent;
}

// The previous channel. Still the way a partner hears a check-in when their installed app
// isn't subscribed, or the push didn't land. Not sent alongside a successful push, or anyone
// who still has both would hear it twice.
async function sendNtfy(goal: Goal, userId?: string): Promise<void> {
  const topic = await getNtfyTopic(userId);
  if (!topic) return;

  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        "Title": `${userId ? userId.charAt(0).toUpperCase() + userId.slice(1) : "Alan"} checked in`,
        "Tags": "white_check_mark",
        "Content-Type": "text/plain",
      },
      body: `${goal.emoji} ${goal.name} (${goal.frequency})`,
    });
    if (!res.ok) console.warn("ntfy responded:", res.status, await res.text());
  } catch (err) {
    console.warn("Notification failed:", err);
  }
}

async function notifyCheckIn(goalId: string, userId?: string): Promise<void> {
  const goals = await getGoals(userId);
  const goal = goals.find((item) => item.id === goalId);
  if (!goal) return;

  let pushed = false;
  try {
    pushed = await pushCheckInToPartner(goal, userId);
  } catch (err) {
    console.warn("Check-in push failed:", err instanceof Error ? err.message : "unknown");
  }
  if (!pushed) await sendNtfy(goal, userId);
}

async function POSTHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { goalId, date } = await req.json();
    const result = await addCheckIn(goalId, date, user);
    // Awaited so the send finishes before the serverless isolate freezes. Returning first
    // drops the notification after the check-in has already saved.
    if (!date) await notifyCheckIn(goalId, user);
    return NextResponse.json(result);
  } catch (err) {
    // The caller's view of this habit is stale, not broken - it graduated out of tracking.
    if (err instanceof GraduatedGoalError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to check in" }, { status: 500 });
  }
}

async function DELETEHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { goalId } = await req.json();
    const result = await undoCheckIn(goalId, user);
    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to undo check-in" }, { status: 500 });
  }
}

export const POST = withPerf("POST /api/checkins", POSTHandler);
export const DELETE = withPerf("DELETE /api/checkins", DELETEHandler);
