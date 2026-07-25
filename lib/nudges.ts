import type { GoalStatus } from "./types";

// Shared by the in-app NudgeAckModal (client, app/components/HabitTracker.tsx) and the
// server-side escalating-text dispatch (app/api/nudge/dispatch/route.ts) so both agree on
// exactly which goals are "still pending" — todayDow is passed in rather than computed here
// so each caller can supply it from its own PST-aware date source.
export function getPendingNudges(goals: GoalStatus[], todayDow: number): GoalStatus[] {
  return goals.filter((g) => {
    if (g.frequency === "daily") {
      return g.nudgeEnabled !== false && g.completedThisPeriod < g.targetCount;
    }
    if (g.nudgeDays && g.nudgeDays.includes(todayDow)) {
      return g.completedThisPeriod < g.targetCount && g.todayCount === 0;
    }
    return false;
  });
}
