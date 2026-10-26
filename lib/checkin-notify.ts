import {
  findUserByPhone,
  getGoals,
  getNtfyTopic,
  getPushSubscriptions,
  getUsers,
  removePushSubscriptions,
  resolveUser,
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

// Shared by the check-in button and a texted "done", so the two can't drift on who hears it
// or which tag it rides. The caller decides whether this check-in is live. A history backfill
// does not call this.
export async function notifyCheckIn(goalId: string, userId?: string): Promise<void> {
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
