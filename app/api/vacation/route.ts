import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import {
  getActiveVacation,
  getUpcomingVacation,
  startVacation,
  endVacationNow,
  resolveUser,
  getGoals,
  getTodayDate,
  type VacationGoalPlan,
} from "@/lib/kv";
import { weeksInRange } from "@/lib/dates";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function GETHandler(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const [active, upcoming] = await Promise.all([getActiveVacation(user), getUpcomingVacation(user)]);
  return NextResponse.json({ active, upcoming });
}

async function POSTHandler(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const { startDate, endDate, plan } = await req.json();
  const today = getTodayDate();
  if (typeof startDate !== "string" || !DATE_RE.test(startDate) || startDate < today) {
    return NextResponse.json({ error: "Invalid start date" }, { status: 400 });
  }
  if (typeof endDate !== "string" || !DATE_RE.test(endDate) || endDate < startDate) {
    return NextResponse.json({ error: "Invalid end date" }, { status: 400 });
  }

  // Every habit, in every week the vacation touches, needs a deliberate number - that's the
  // whole point of planning one. A missing entry is rejected rather than defaulted, because a
  // default is exactly the unconsidered choice this is meant to replace.
  const goals = (await getGoals(user)).filter((g) => !g.graduatedAt);
  const weeks = weeksInRange(startDate, endDate);
  if (!Array.isArray(plan) || plan.length !== weeks.length) {
    return NextResponse.json({ error: "Plan every week of the vacation" }, { status: 400 });
  }
  const byWeek = new Map<string, Record<string, VacationGoalPlan>>();
  for (const entry of plan) {
    if (!entry || typeof entry.week !== "string" || !weeks.includes(entry.week) || byWeek.has(entry.week)) {
      return NextResponse.json({ error: "Plan every week of the vacation" }, { status: 400 });
    }
    const goalsForWeek: Record<string, VacationGoalPlan> = {};
    for (const goal of goals) {
      const planned = entry.goals?.[goal.id];
      if (!planned || !Number.isInteger(planned.targetCount) || planned.targetCount < 0) {
        return NextResponse.json(
          { error: `Set a target for ${goal.name} in ${entry.week}` },
          { status: 400 }
        );
      }
      goalsForWeek[goal.id] = {
        targetCount: planned.targetCount,
        ...(TIME_RE.test(planned.nudgeTime ?? "") ? { nudgeTime: planned.nudgeTime } : {}),
        ...(Array.isArray(planned.nudgeDays)
          ? { nudgeDays: planned.nudgeDays.filter((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) }
          : {}),
        ...(planned.nudgeEnabled === false ? { nudgeEnabled: false } : {}),
      };
    }
    byWeek.set(entry.week, goalsForWeek);
  }

  const window = await startVacation(
    startDate,
    endDate,
    weeks.map((week) => ({ week, goals: byWeek.get(week)! })),
    user
  );
  const [active, upcoming] = await Promise.all([getActiveVacation(user), getUpcomingVacation(user)]);
  return NextResponse.json({ active, upcoming, window });
}

async function DELETEHandler(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  await endVacationNow(user);
  return NextResponse.json({ ok: true });
}

export const GET = withPerf("GET /api/vacation", GETHandler);
export const POST = withPerf("POST /api/vacation", POSTHandler);
export const DELETE = withPerf("DELETE /api/vacation", DELETEHandler);
