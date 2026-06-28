import { NextResponse } from "next/server";
import { getGoals, getCompletedThisPeriod, getCheckInsForPeriod, getTodayDate, resolveUser } from "@/lib/kv";
import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

function getTodayPST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

function getTodayDOW(): number {
  return new Date(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()) + "T12:00:00"
  ).getDay();
}

export async function GET(req: Request) {
  const userId = resolveUser(new URL(req.url).searchParams.get("user"));
  const topicKey = userId ? `NTFY_${userId.toUpperCase()}_NUDGE_TOPIC` : "NTFY_ALAN_TOPIC";
  const topic = process.env[topicKey];
  if (!topic) {
    return NextResponse.json({ error: `${topicKey} not set` }, { status: 500 });
  }

  const todayDow = getTodayDOW();
  const today = getTodayPST();

  const goals = await getGoals(userId);

  const displayName = userId
    ? userId.charAt(0).toUpperCase() + userId.slice(1)
    : "Alan";

  const nudgeMessages: Record<string, { title: string; body: string }> = {
    sleep: {
      title: "Still awake?",
      body: `It's 10PM and you haven't logged sleep yet. You know what happens when you don't sleep, ${displayName}. Everything gets worse.`,
    },
  };

  const fallback = (g: { emoji: string; name: string }) => ({
    title: "Seriously? Still?",
    body: `${g.emoji} ${g.name} — still not done. What are you even doing with your life, ${displayName}.`,
  });

  const sent: string[] = [];

  for (const goal of goals) {
    // Per-goal dedup — only nudge once per day
    const sentKey = `remind:sent:${userId ?? "alan"}:${goal.id}:${today}`;
    if (await kv.get(sentKey)) continue;

    let shouldNudge = false;
    if (goal.frequency === "daily") {
      const completed = await getCompletedThisPeriod(goal, userId);
      shouldNudge = completed < goal.targetCount;
    } else if (goal.nudgeDays && goal.nudgeDays.includes(todayDow)) {
      const [completed, todayCount] = await Promise.all([
        getCompletedThisPeriod(goal, userId),
        getCheckInsForPeriod(goal.id, getTodayDate(), userId),
      ]);
      shouldNudge = completed < goal.targetCount && todayCount === 0;
    }

    if (!shouldNudge) continue;

    const msg = nudgeMessages[goal.id] ?? fallback(goal);
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: msg.title,
        Tags: "face_with_raised_eyebrow",
        Priority: "default",
        "Content-Type": "text/plain",
      },
      body: msg.body,
    });

    await kv.set(sentKey, 1, { ex: 90000 });
    sent.push(goal.name);
  }

  return NextResponse.json(sent.length > 0 ? { sent: true, goals: sent } : { sent: false });
}
