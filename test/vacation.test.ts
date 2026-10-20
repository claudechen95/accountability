import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { fakeRedis } from "./redis-fake";
import { POST as vacationPOST } from "@/app/api/vacation/route";
import { getStreak, getNudgeCandidates, getGoalHistories } from "@/lib/kv";
import { getPendingNudges } from "@/lib/nudges";
import type { Goal } from "@/lib/types";

// A vacation is planned week by week: every habit gets an explicit target for every week the
// trip touches, and 0 is the way to say "not this week". What these cover is the two halves of
// that - the API refusing a plan with a hole in it, and the scoring treating a planned week as
// the week the user actually signed up for rather than as an ordinary one.

const NOW = new Date("2026-08-26T18:00:00Z"); // Wed 26 Aug 2026, 11:00 PDT
const TODAY = "2026-08-26";
const U = "testuser";

function goal(over: Partial<Goal> = {}): Goal {
  return { id: "piano", name: "Piano", emoji: "🎹", frequency: "weekly", targetCount: 3, ...over };
}

function setGoals(...goals: Goal[]) {
  fakeRedis.seed(`${U}:goals`, goals);
}

/** Check the habit in on `days` consecutive days from `monday`. */
function seedDays(goalId: string, monday: string, days: number) {
  const [y, m, d] = monday.split("-").map(Number);
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    fakeRedis.seed(`${U}:checkin:${goalId}:${day.toISOString().slice(0, 10)}`, 1);
  }
}

function seedVacation(window: Record<string, unknown>) {
  fakeRedis.seed(`${U}:settings:vacation`, [window]);
}

async function post(body: Record<string, unknown>) {
  return vacationPOST(
    new Request(`http://localhost/api/vacation?user=${U}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => fakeRedis.reset());

describe("planning a vacation", () => {
  const WEEK1 = "2026-W36"; // Mon 31 Aug
  const WEEK2 = "2026-W37"; // Mon 7 Sep
  const span = { startDate: "2026-08-31", endDate: "2026-09-08" }; // spills into a second week

  it("refuses a plan that doesn't cover every week of the trip", async () => {
    setGoals(goal());

    const res = await post({ ...span, plan: [{ week: WEEK1, goals: { piano: { targetCount: 0 } } }] });

    expect(res.status).toBe(400);
    expect(await fakeRedis.get(`${U}:settings:vacation`)).toBeNull();
  });

  // The point of planning is that no habit gets a target by default - silence isn't a choice.
  it("refuses a week with a habit left undecided", async () => {
    setGoals(goal(), goal({ id: "gym", name: "Gym" }));

    const res = await post({
      ...span,
      plan: [
        { week: WEEK1, goals: { piano: { targetCount: 1 }, gym: { targetCount: 0 } } },
        { week: WEEK2, goals: { piano: { targetCount: 1 } } },
      ],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Gym");
  });

  it("stores the plan and derives the paused habits from the zeros", async () => {
    setGoals(goal(), goal({ id: "gym", name: "Gym" }));

    const res = await post({
      ...span,
      plan: [
        { week: WEEK1, goals: { piano: { targetCount: 1 }, gym: { targetCount: 0 } } },
        { week: WEEK2, goals: { piano: { targetCount: 3 }, gym: { targetCount: 0 } } },
      ],
    });

    expect(res.status).toBe(200);
    const { window } = await res.json();
    expect(window.goalIds).toEqual(["gym"]);
    expect(window.plan).toHaveLength(2);
    expect(window.plan[0].goals.piano.targetCount).toBe(1);
  });

  it("keeps a nudge override for a planned week", async () => {
    setGoals(goal());

    const res = await post({
      startDate: "2026-08-31",
      endDate: "2026-09-06",
      plan: [
        {
          week: WEEK1,
          goals: { piano: { targetCount: 2, nudgeTime: "08:30", nudgeDays: [2, 4] } },
        },
      ],
    });

    const { window } = await res.json();
    expect(window.plan[0].goals.piano).toEqual({
      targetCount: 2,
      nudgeTime: "08:30",
      nudgeDays: [2, 4],
    });
  });
});

describe("scoring a planned vacation week", () => {
  // Weeks run Monday–Sunday: W35 is the current one (Aug 24), W34 Aug 17, W33 Aug 10, W32 Aug 3.
  const plannedWeek = (targetCount: number) => ({
    startDate: "2026-08-10",
    endDate: "2026-08-16",
    goalIds: targetCount === 0 ? ["piano"] : [],
    plan: [{ week: "2026-W33", goals: { piano: { targetCount } } }],
  });

  it("treats a week planned off as neutral - it neither counts nor breaks", async () => {
    const piano = goal();
    setGoals(piano);
    seedDays("piano", "2026-08-17", 3);
    seedDays("piano", "2026-08-03", 3);
    seedVacation(plannedWeek(0));

    expect(await getStreak(piano, U)).toBe(2);
  });

  it("scores a week the user chose to keep against the target they chose", async () => {
    const piano = goal();
    setGoals(piano);
    seedDays("piano", "2026-08-17", 3);
    seedDays("piano", "2026-08-10", 1); // the one session they planned for
    seedDays("piano", "2026-08-03", 3);
    seedVacation(plannedWeek(1));

    expect(await getStreak(piano, U)).toBe(3);
  });

  it("still breaks the streak on a kept week that missed its reduced target", async () => {
    const piano = goal();
    setGoals(piano);
    seedDays("piano", "2026-08-17", 3);
    seedDays("piano", "2026-08-10", 1);
    seedDays("piano", "2026-08-03", 3);
    seedVacation(plannedWeek(2)); // they planned two and did one

    expect(await getStreak(piano, U)).toBe(1);
  });

  it("paints a planned-off day as vacation rather than done", async () => {
    const protein = goal({ id: "protein", name: "Protein", frequency: "daily", targetCount: 1 });
    setGoals(protein);
    fakeRedis.seed(`${U}:settings:vacation`, [
      {
        startDate: "2026-08-10",
        endDate: "2026-08-16",
        goalIds: ["protein"],
        plan: [{ week: "2026-W33", goals: { protein: { targetCount: 0 } } }],
      },
    ]);

    const [{ entries }] = await getGoalHistories(U);
    const day = entries.find((e) => e.period === "2026-08-12")!;
    expect(day.vacation).toBe(true);
    expect(day.done).toBe(false);
  });
});

describe("nudges during a planned vacation week", () => {
  const DOW_WED = 3;
  const LATE = 23 * 60;

  it("drops a habit planned off that week", async () => {
    setGoals(goal({ nudgeDays: [DOW_WED] }));
    fakeRedis.seed(`${U}:settings:vacation`, [
      {
        startDate: "2026-08-24",
        endDate: "2026-08-30",
        goalIds: ["piano"],
        plan: [{ week: "2026-W35", goals: { piano: { targetCount: 0 } } }],
      },
    ]);

    expect(await getNudgeCandidates(TODAY, U)).toEqual([]);
  });

  it("silences a kept habit for the week without excusing it", async () => {
    setGoals(goal({ nudgeDays: [DOW_WED] }));
    fakeRedis.seed(`${U}:settings:vacation`, [
      {
        startDate: "2026-08-24",
        endDate: "2026-08-30",
        goalIds: [],
        plan: [{ week: "2026-W35", goals: { piano: { targetCount: 1, nudgeEnabled: false } } }],
      },
    ]);

    const candidates = await getNudgeCandidates(TODAY, U);
    expect(candidates).toHaveLength(1); // still tracked, still scored
    expect(getPendingNudges(candidates, DOW_WED, LATE)).toEqual([]); // just not asking
  });

  it("moves a kept habit's reminder to the week's own time", async () => {
    setGoals(goal({ nudgeDays: [DOW_WED], nudgeTime: "21:00" }));
    fakeRedis.seed(`${U}:settings:vacation`, [
      {
        startDate: "2026-08-24",
        endDate: "2026-08-30",
        goalIds: [],
        plan: [{ week: "2026-W35", goals: { piano: { targetCount: 1, nudgeTime: "08:30" } } }],
      },
    ]);

    const candidates = await getNudgeCandidates(TODAY, U);
    expect(candidates[0].nudgeTime).toBe("08:30");
    // 9am would be far too early for the habit's own 21:00, and is right for this week's 08:30.
    expect(getPendingNudges(candidates, DOW_WED, 9 * 60)).toHaveLength(1);
  });

  it("still pauses a habit listed by a window written before planning existed", async () => {
    setGoals(goal({ nudgeDays: [DOW_WED] }));
    seedVacation({ startDate: "2026-08-24", endDate: "2026-08-30", goalIds: ["piano"] });

    expect(await getNudgeCandidates(TODAY, U)).toEqual([]);
  });
});
