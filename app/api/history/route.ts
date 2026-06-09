import { NextResponse } from "next/server";
import { getGoals, getHistory, getStreak, getReflectionsForGoal } from "@/lib/kv";

export async function GET() {
  try {
    const goals = await getGoals();

    const history = await Promise.all(
      goals.map(async (goal) => {
        const periods = 91;
        const [entries, streak] = await Promise.all([
          getHistory(goal, periods),
          getStreak(goal),
        ]);

        // Reflections are now stored by date key for all goal types
        const reflections = await getReflectionsForGoal(goal.id, entries.map((e) => e.period));

        return { goal, entries, streak, reflections };
      })
    );

    return NextResponse.json(history);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load history" }, { status: 500 });
  }
}
