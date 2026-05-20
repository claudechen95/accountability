import { NextResponse } from "next/server";
import { getGoals, getCompletedThisPeriod, getCheckInsForPeriod, getTodayDate } from "@/lib/kv";
import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

function getTodayPST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

function getCurrentPSTHour(): number {
  const pst = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return pst.getHours();
}

function getTodayDOW(): number {
  return new Date(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()) + "T12:00:00"
  ).getDay();
}

export async function GET() {
  const topic = process.env.NTFY_ALAN_TOPIC;
  if (!topic) {
    return NextResponse.json({ error: "NTFY_ALAN_TOPIC not set" }, { status: 500 });
  }

  const currentHour = getCurrentPSTHour();
  const todayDow = getTodayDOW();
  const today = getTodayPST();

  const goals = await getGoals();

  const nudgeMessages: Record<string, { title: string; body: string }> = {
    sleep: {
      title: "Still awake?",
      body: "It's 10PM and you haven't logged sleep yet. You know what happens when you don't sleep, Alan. Everything gets worse.",
    },
  };

  const fallback = (g: { emoji: string; name: string }) => ({
    title: "Seriously? Still?",
    body: `${g.emoji} ${g.name} — still not done. What are you even doing with your life, Alan.`,
  });

  const sent: string[] = [];

  for (const goal of goals) {
    // Check if this goal should nudge at the current hour (default 21:00)
    const goalHour = goal.nudgeTime ? parseInt(goal.nudgeTime.split(":")[0], 10) : 21;
    if (currentHour !== goalHour) continue;

    // Per-goal dedup — only nudge once per day
    const sentKey = `remind:sent:${goal.id}:${today}`;
    if (await kv.get(sentKey)) continue;

    let shouldNudge = false;
    if (goal.frequency === "daily") {
      const completed = await getCompletedThisPeriod(goal);
      shouldNudge = completed < goal.targetCount;
    } else if (goal.nudgeDays && goal.nudgeDays.includes(todayDow)) {
      const [completed, todayCount] = await Promise.all([
        getCompletedThisPeriod(goal),
        getCheckInsForPeriod(goal.id, getTodayDate()),
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
