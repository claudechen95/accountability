import { NextResponse } from "next/server";
import { getGoals, saveGoals, getCompletedThisPeriod, getStreak, getCheckInsForPeriod, getTodayDate, getLastPeriodMissed } from "@/lib/kv";
import type { GoalStatus } from "@/lib/types";

export async function GET() {
  try {
    const goals = await getGoals();

    const statuses: GoalStatus[] = await Promise.all(
      goals.map(async (goal) => {
        const [completed, streak, todayCount, lastPeriodMissed] = await Promise.all([
          getCompletedThisPeriod(goal),
          getStreak(goal),
          getCheckInsForPeriod(goal.id, getTodayDate()),
          getLastPeriodMissed(goal),
        ]);
        return {
          ...goal,
          completedThisPeriod: completed,
          isDone: completed >= goal.targetCount,
          streak,
          todayCount,
          lastPeriodMissed,
        };
      })
    );

    return NextResponse.json(statuses);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load goals" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const goals = await getGoals();

    // Add or update a goal
    const existing = goals.findIndex((g) => g.id === body.id);
    if (existing >= 0) {
      goals[existing] = { ...goals[existing], ...body };
    } else {
      goals.push(body);
    }
    await saveGoals(goals);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to save goal" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const { orderedIds } = await req.json();
    if (!Array.isArray(orderedIds)) {
      return NextResponse.json({ error: "orderedIds required" }, { status: 400 });
    }
    const goals = await getGoals();
    (orderedIds as string[]).forEach((id, index) => {
      const goal = goals.find((g) => g.id === id);
      if (goal) goal.order = index;
    });
    await saveGoals(goals);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to update order" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();
    const goals = await getGoals();
    await saveGoals(goals.filter((g) => g.id !== id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to delete goal" }, { status: 500 });
  }
}
