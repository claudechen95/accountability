import { NextResponse } from "next/server";
import { getGoals, getHistory, getStreak, getWeekKey, getReflectionsForGoal } from "@/lib/kv";

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

        let reflections: Record<string, string> = {};
        if (goal.frequency === "daily") {
          reflections = await getReflectionsForGoal(goal.id, entries.map((e) => e.period));
        } else {
          const weekKeys = [...new Set(entries.map((e) => getWeekKey(e.period)))];
          const weekReflections = await getReflectionsForGoal(goal.id, weekKeys);
          for (const entry of entries) {
            const wk = getWeekKey(entry.period);
            if (weekReflections[wk] && !entry.done) {
              reflections[entry.period] = weekReflections[wk];
            }
          }
        }

        return { goal, entries, streak, reflections };
      })
    );

    return NextResponse.json(history);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load history" }, { status: 500 });
  }
}
