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
          const weekKeySet: Record<string, true> = {};
          for (const e of entries) weekKeySet[getWeekKey(e.period)] = true;
          const weekKeys = Object.keys(weekKeySet);
          const weekReflections = await getReflectionsForGoal(goal.id, weekKeys);
          // Only attach a weekly reflection to the last missed day of that week,
          // so the same text doesn't appear on every missed cell in the week.
          const weekLastMissed: Record<string, string> = {};
          for (const entry of entries) {
            const wk = getWeekKey(entry.period);
            if (weekReflections[wk] && !entry.done) {
              weekLastMissed[wk] = entry.period; // keep overwriting → ends up as last missed day
            }
          }
          for (const [wk, period] of Object.entries(weekLastMissed)) {
            reflections[period] = weekReflections[wk];
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
