import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { vi } from "vitest";
import {
  addCheckIn,
  getGoalHistories,
  getReflectionPrompt,
  getReflectionsForGoal,
  saveReflection,
} from "@/lib/kv";
import type { Goal } from "@/lib/types";
import { fakeRedis } from "./redis-fake";

// Pinned to a Wednesday so every scenario is constructible and none of them depend on the day
// the suite happens to run. Wed 26 Aug 2026, 11:00 PDT: the week runs Mon 24 - Sun 30, so
// there are 5 days left in it (Wed through Sun) and 2 already spent.
const NOW = new Date("2026-08-26T18:00:00Z");
const MONDAY = "2026-08-24";
const U = "testuser"; // not Alan's namespace, so getGoals' Alan-only migrations stay out of it

function shift(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

const weekDay = (i: number) => shift(MONDAY, i);
const lastWeekDay = (i: number) => shift(MONDAY, i - 7);

/** Give the goal some check-in history, which is what makes it eligible to be prompted at all. */
function seedCheckIns(goalId: string, dates: string[]) {
  for (const date of dates) fakeRedis.seed(`${U}:checkin:${goalId}:${date}`, 1);
  // One record per check-in, seeded oldest first. The list is written newest-first, so this puts
  // the earliest at the tail - which is where the daily lookback reads the habit's start date
  // from, and why a habit can't be asked about days before it existed.
  for (const date of [...dates].sort()) {
    fakeRedis.seedListEntry(`${U}:history:${goalId}`, { goalId, timestamp: 1, date, week: "seed" });
  }
  if (dates.length === 0) {
    fakeRedis.seedListEntry(`${U}:history:${goalId}`, { goalId, timestamp: 1, date: MONDAY, week: "seed" });
  }
}

const weekly = (id: string, targetCount: number, nudgeDays?: number[]): Goal =>
  ({ id, name: id, emoji: "x", frequency: "weekly", targetCount, nudgeDays });
const daily = (id: string): Goal =>
  ({ id, name: id, emoji: "x", frequency: "daily", targetCount: 1 });

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => fakeRedis.reset());

describe("getReflectionPrompt - daily goals", () => {
  const TODAY = "2026-08-26";
  const seedReflection = (goalId: string, date: string) =>
    fakeRedis.seed(`${U}:reflection:${goalId}:${date}`, { text: "already said", savedAt: 1 });

  it("asks, and requires an answer, when yesterday had no check-in", async () => {
    seedCheckIns("d", [shift(TODAY, -2)]);
    expect(await getReflectionPrompt(daily("d"), U)).toEqual({
      reason: "missed-day",
      dates: ["2026-08-25"],
      required: true,
    });
  });

  it("asks about the whole run of misses, not just the last day of it", async () => {
    // The gap this replaced: the prompt fires on the next check-in and only ever looked at
    // yesterday, so 22nd-25th produced one reflection filed on the 25th and the three days
    // inside the run could never be reflected on at all.
    seedCheckIns("d", [shift(TODAY, -5)]);
    expect(await getReflectionPrompt(daily("d"), U)).toMatchObject({
      dates: ["2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25"],
      required: true,
    });
  });

  it("asks about an older backlog without charging the check-in for it", async () => {
    // Yesterday is fine, so nothing has just been lost - but the 23rd was missed and never
    // answered for, which used to be unreachable once the next day's check-in went in.
    seedCheckIns("d", [shift(TODAY, -4), shift(TODAY, -2), shift(TODAY, -1)]);
    expect(await getReflectionPrompt(daily("d"), U)).toEqual({
      reason: "missed-day",
      dates: ["2026-08-23"],
      required: false,
    });
  });

  it("stays quiet when yesterday was done", async () => {
    seedCheckIns("d", ["2026-08-25"]);
    expect(await getReflectionPrompt(daily("d"), U)).toBeNull();
  });

  it("drops days that have already been reflected on", async () => {
    seedCheckIns("d", [shift(TODAY, -3)]);
    seedReflection("d", "2026-08-24");
    // Asking again would overwrite the answer already given for the 24th.
    expect(await getReflectionPrompt(daily("d"), U)).toMatchObject({ dates: ["2026-08-25"] });
  });

  it("never asks about a vacation day, but still asks about the misses around it", async () => {
    seedCheckIns("d", [shift(TODAY, -10)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: "2026-08-20", endDate: "2026-08-26", goalIds: ["d"] },
    ]);
    expect(await getReflectionPrompt(daily("d"), U)).toMatchObject({
      dates: ["2026-08-17", "2026-08-18", "2026-08-19"],
      required: false, // yesterday was paused, so nothing was lost yesterday
    });
  });

  it("never asks about days before the habit's first check-in", async () => {
    // Otherwise a habit added the day before yesterday opens with a fortnight of misses to
    // account for, none of which it was around for.
    seedCheckIns("d", [shift(TODAY, -2)]);
    const prompt = await getReflectionPrompt(daily("d"), U);
    expect(prompt).toMatchObject({ dates: ["2026-08-25"] });
  });

  it("goes quiet again once the whole run has been answered", async () => {
    fakeRedis.seed(`${U}:goals`, [daily("d")]);
    seedCheckIns("d", [shift(TODAY, -5)]);
    await saveReflection("d", "Was travelling all week", U);
    expect(await getReflectionPrompt(daily("d"), U)).toBeNull();
  });
});

describe("saveReflection", () => {
  const TODAY = "2026-08-26";

  /**
   * The days a reflection is filed under - which are the days it's *about*, and the days that
   * therefore can't be asked about again. Read here rather than off the history payload, which
   * re-keys by the day the text was written.
   */
  async function storedDays(goalId: string): Promise<string[]> {
    const window = Array.from({ length: 21 }, (_, i) => shift(TODAY, i - 20));
    return Object.keys(await getReflectionsForGoal(goalId, window, U)).sort();
  }

  it("files one daily reflection against every missed day it named", async () => {
    fakeRedis.seed(`${U}:goals`, [daily("d")]);
    seedCheckIns("d", [shift(TODAY, -4)]);
    await saveReflection("d", "Was travelling all week", U);

    expect(await storedDays("d")).toEqual(["2026-08-23", "2026-08-24", "2026-08-25"]);
  });

  it("files a weekly reflection against the day its prompt named", async () => {
    // The prompt asks about last Sunday, so that's the day the text answers for and the day that
    // mustn't be raised again. Where it *shows* is a separate question - the grid rings the day
    // it was written.
    fakeRedis.seed(`${U}:goals`, [weekly("w", 3)]);
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1)]);
    await saveReflection("w", "Weekend got away from me", U);

    expect(await storedDays("w")).toEqual(["2026-08-23"]);
  });

  it("falls back to yesterday when there's nothing outstanding", async () => {
    // A dismissed prompt re-opened after the habit was backfilled, or a stale tab - the text
    // still has to land somewhere, and yesterday is where it always landed.
    fakeRedis.seed(`${U}:goals`, [daily("d")]);
    seedCheckIns("d", [shift(TODAY, -1)]);
    await saveReflection("d", "Nothing outstanding", U);

    expect(await storedDays("d")).toEqual(["2026-08-25"]);
  });
});

describe("getReflectionPrompt - weekly goals", () => {
  // The point of the weekly rules: a 3x/week habit is scored over the whole week, so one
  // skipped day mid-week is not a miss and must not be treated as one.
  it("says nothing about a mid-week skip while the target is still comfortable", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(2), lastWeekDay(4), weekDay(0)]);
    // 1 of 3 done, 5 days left: 2 still needed against 5 open days is not behind.
    expect(await getReflectionPrompt(weekly("w", 3), U)).toBeNull();
  });

  it("asks, but does not require, when the week is winnable only if every day lands", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1), lastWeekDay(2), lastWeekDay(3), lastWeekDay(4)]);
    // 0 of 5 done with exactly 5 days left. Still achievable, and the user is checking in right
    // now, so charging them for good behaviour would turn the prompt into noise.
    expect(await getReflectionPrompt(weekly("w", 5), U)).toEqual({
      reason: "week-behind",
      date: "2026-08-25", // Tuesday, the last day of this week that closed unfilled
      completed: 0,
      target: 5,
      daysLeft: 5,
      required: false,
    });
  });

  it("requires a reflection once the target is out of reach", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1), lastWeekDay(2), lastWeekDay(3), lastWeekDay(4), lastWeekDay(5), lastWeekDay(6)]);
    // 0 of 7 with 5 days left: the week is lost, so the only useful move is naming why.
    // Today is unfilled too and is deliberately not the day named - it hasn't closed yet, and
    // the user is checking in as we ask, so calling it a miss would be a lie.
    expect(await getReflectionPrompt(weekly("w", 7), U)).toMatchObject({
      reason: "week-behind",
      date: "2026-08-25",
      required: true,
    });
  });

  it("catches a week that quietly closed short, on the first check-in of the new one", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1)]);
    expect(await getReflectionPrompt(weekly("w", 3), U)).toEqual({
      reason: "week-missed",
      date: "2026-08-23", // Sunday, the last day of last week that went unfilled
      completed: 2,
      target: 3,
      required: true,
    });
  });

  // Which day gets named. A week's arithmetic isn't answerable, so the prompt points at one day
  // of it - and where the habit has a schedule, that day has to be a day it was scheduled on.
  it("names the last missed nudge day rather than the last day of the week", async () => {
    // 1x/week on Wednesdays, nothing done last week. Sunday is the last unfilled day, but
    // Wednesday is the day that was actually asked for.
    seedCheckIns("w", []);
    expect(await getReflectionPrompt(weekly("w", 1, [3]), U)).toMatchObject({
      reason: "week-missed",
      date: "2026-08-19",
    });
  });

  it("falls back to any unfilled day for a habit with no nudge days set", async () => {
    // Same data, no schedule to appeal to - several habits leave nudgeDays empty, and one of
    // them saying nothing at all would be worse than naming the week's last open day.
    seedCheckIns("w", []);
    expect(await getReflectionPrompt(weekly("w", 1), U)).toMatchObject({
      reason: "week-missed",
      date: "2026-08-23",
    });
  });

  it("falls back to any unfilled day when every scheduled day was filled", async () => {
    // 3x/week nudging Mon only, done Mon. The schedule was kept and the target still wasn't,
    // so insisting on a missed nudge day would leave nothing to name.
    seedCheckIns("w", [lastWeekDay(0)]);
    expect(await getReflectionPrompt(weekly("w", 3, [1]), U)).toMatchObject({
      reason: "week-missed",
      date: "2026-08-23",
    });
  });

  // A day asked and answered settles its week. The weekly path used to skip this check: a
  // behind week re-named its missed Friday on every later day's check-in, and because a
  // reflection is filed under the day it names, each forced re-answer overwrote the last.
  const seedReflection = (goalId: string, date: string) =>
    fakeRedis.seed(`${U}:reflection:${goalId}:${date}`, { text: "already said", savedAt: 1 });

  it("stands down while the day it would name carries a reflection, and re-opens on a new miss", async () => {
    // The sequence from the bug, Wednesday then Thursday: the week is out of reach and
    // Tuesday's miss gets answered. The week is still out of reach the next day, but it has
    // been accounted for - there's no second question until a new day closes unfilled.
    fakeRedis.seed(`${U}:goals`, [weekly("w", 7)]);
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1), lastWeekDay(2), lastWeekDay(3), lastWeekDay(4), lastWeekDay(5), lastWeekDay(6)]);

    expect(await getReflectionPrompt(weekly("w", 7), U)).toMatchObject({ date: "2026-08-25" });
    await saveReflection("w", "Tuesday got away from me", U);
    expect(await getReflectionPrompt(weekly("w", 7), U)).toBeNull();

    // Thursday: Wednesday has now closed unfilled too - a fresh miss since the answer, so a
    // fresh question, about the fresh day.
    vi.setSystemTime(new Date("2026-08-27T18:00:00Z"));
    try {
      expect(await getReflectionPrompt(weekly("w", 7), U)).toMatchObject({ date: "2026-08-26" });
    } finally {
      vi.setSystemTime(NOW);
    }
  });

  it("settles on one answer rather than walking back to older unfilled days", async () => {
    // Monday is also unfilled, but unfilled days aren't individually misses for a weekly habit
    // - the question is the week's, and Tuesday's reflection answered it. Walking back would
    // demand a separate essay per empty day of an already-answered week.
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1), lastWeekDay(2), lastWeekDay(3), lastWeekDay(4), lastWeekDay(5), lastWeekDay(6)]);
    seedReflection("w", "2026-08-25");
    expect(await getReflectionPrompt(weekly("w", 7), U)).toBeNull();
  });

  it("does not re-ask at the week's close about a miss answered while it was running", async () => {
    // 2 of 3 last week, and the day week-missed would name (Sunday) was already reflected on
    // via week-behind. The close-out isn't a second question - this is the same data as the
    // week-missed case above, which fires only because its Sunday was never answered.
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(1)]);
    seedReflection("w", "2026-08-23");
    expect(await getReflectionPrompt(weekly("w", 3), U)).toBeNull();
  });

  it("never names a paused day, even though nothing was logged on it", async () => {
    // Tuesday was vacation, so it's not a miss - Monday is the last day actually expected.
    seedCheckIns("w", [shift("2026-08-26", -30)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: weekDay(1), endDate: weekDay(1), goalIds: ["w"] },
    ]);
    expect(await getReflectionPrompt(weekly("w", 7), U)).toMatchObject({
      reason: "week-behind",
      date: "2026-08-24",
    });
  });

  it("keeps the week's counts when the week is behind before any day has closed", async () => {
    // Mon and Tue both paused, so this week is already out of slack with not one closed day in
    // it to point at. There's no honest day to name, and the arithmetic is what's left.
    seedCheckIns("w", [shift("2026-08-26", -30)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: weekDay(0), endDate: weekDay(1), goalIds: ["w"] },
    ]);
    expect(await getReflectionPrompt(weekly("w", 7), U)).toMatchObject({
      reason: "week-behind",
      date: null,
      completed: 0,
      target: 5,
      daysLeft: 5,
    });
  });

  // The knife's edge is only a knife's edge when the check-in being made isn't enough by
  // itself. These run on Sunday, the one day `needed === daysLeft === 1` is constructible.
  describe("on the week's last day", () => {
    beforeAll(() => vi.setSystemTime(new Date("2026-08-30T18:00:00Z")));
    afterAll(() => vi.setSystemTime(NOW));

    it("says nothing to a 1x/week habit being done on its scheduled day", async () => {
      // Screen time Review: 1x/week, nudged on Sunday, checked in on Sunday. Doing the habit
      // exactly on schedule used to read as "behind", naming Saturday as a miss it never was.
      seedCheckIns("w", [lastWeekDay(6)]);
      expect(await getReflectionPrompt(weekly("w", 1, [0]), U)).toBeNull();
    });

    it("says nothing when this check-in alone completes the target", async () => {
      // 5x/week with 4 done: the user is finishing the week as we ask, not falling behind it.
      seedCheckIns("w", [weekDay(0), weekDay(1), weekDay(2), weekDay(3)]);
      expect(await getReflectionPrompt(weekly("w", 5), U)).toBeNull();
    });

    it("still requires a reflection when one check-in can no longer save the week", async () => {
      seedCheckIns("w", [lastWeekDay(6)]);
      // 0 of 2 with only today left: the week is lost whatever happens now.
      expect(await getReflectionPrompt(weekly("w", 2), U)).toMatchObject({
        reason: "week-behind",
        required: true,
      });
    });
  });

  it("says nothing when last week hit its target", async () => {
    seedCheckIns("w", [lastWeekDay(0), lastWeekDay(2), lastWeekDay(4)]);
    expect(await getReflectionPrompt(weekly("w", 2), U)).toBeNull();
  });

  it("says nothing while a vacation covers both the current and previous week", async () => {
    seedCheckIns("w", [shift("2026-08-26", -30)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: lastWeekDay(0), endDate: weekDay(6), goalIds: ["w"] },
    ]);
    // Both weeks prorate to a target of 0, so neither can be behind or missed.
    expect(await getReflectionPrompt(weekly("w", 3), U)).toBeNull();
  });

  it("prorates the target down for paused days instead of counting them as misses", async () => {
    // 5x/week, done Mon and Tue, then Wed-Sun paused. Only 2 days of the week were ever
    // available, so the target prorates 5 -> 2 and the habit is square. Without proration this
    // would read as 2 of 5 with 0 days left, i.e. a required "you blew the week" prompt for
    // days the user was never expected to show up on.
    seedCheckIns("w", [weekDay(0), weekDay(1)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: weekDay(2), endDate: weekDay(6), goalIds: ["w"] },
    ]);
    expect(await getReflectionPrompt(weekly("w", 5), U)).toBeNull();
  });

  it("still reports a genuinely missed previous week when only the current week is paused", async () => {
    // The pause says nothing about last week, which really did close at 0 of 3.
    seedCheckIns("w", [shift("2026-08-26", -30)]);
    fakeRedis.seed(`${U}:settings:vacation`, [
      { startDate: MONDAY, endDate: weekDay(6), goalIds: ["w"] },
    ]);
    expect(await getReflectionPrompt(weekly("w", 3), U)).toMatchObject({
      reason: "week-missed",
      required: true,
    });
  });
});

describe("getReflectionPrompt - when not to ask at all", () => {
  it("never prompts a brand-new habit with no history", async () => {
    expect(await getReflectionPrompt(weekly("fresh", 3), U)).toBeNull();
  });

  it("never prompts a graduated habit, which has no expectations left to fall behind", async () => {
    seedCheckIns("g", [lastWeekDay(0), lastWeekDay(1)]);
    const graduated: Goal = { ...weekly("g", 3), graduatedAt: "2026-08-20", graduatedRun: 12 };
    // Same data that produced a required week-missed above.
    expect(await getReflectionPrompt(graduated, U)).toBeNull();
  });
});

describe("a saved reflection reaches the history grid", () => {
  const TODAY = "2026-08-26";

  it("comes back against the day it was written, even though that day is completed", async () => {
    // A weekly reflection saved with no prompt outstanding still falls back to today, and then
    // the check-in it was gating goes through on that same day. So a reflection and a completed
    // day can share a period, and the grid has to show both.
    // It used to look reflections up only for *missed* days, which meant every reflection a
    // weekly habit collected on a day it completed was dropped on the floor.
    fakeRedis.seed(`${U}:goals`, [weekly("w", 6)]);
    await saveReflection("w", "Work had early meetings", U);
    await addCheckIn("w", TODAY, U);

    const history = (await getGoalHistories(U)).find((h) => h.goal.id === "w")!;
    const today = history.entries.find((e) => e.period === TODAY)!;

    expect(today.done).toBe(true);
    expect(history.reflections[TODAY]).toBe("Work had early meetings");
  });

  it("shows on the day it was written, not the days it is about", async () => {
    // A daily reflection is *stored* against every miss it answers for, so those days can't be
    // asked about again. The grid shows the one day it was written on instead - that's the day
    // the user actually sat down and wrote it.
    fakeRedis.seed(`${U}:goals`, [daily("d")]);
    seedCheckIns("d", [shift(TODAY, -5)]);
    await saveReflection("d", "Travelling all week", U);

    const history = (await getGoalHistories(U)).find((h) => h.goal.id === "d")!;

    expect(history.reflections).toEqual({ [TODAY]: "Travelling all week" });
  });

  it("finds a reflection filed under a day older than the grid but written inside it", async () => {
    // Stored key and written day can be a fortnight apart, so the read has to reach back past
    // the window's own first day or a reflection at its left edge goes missing.
    const windowStart = shift(TODAY, -90);
    fakeRedis.seed(`${U}:goals`, [daily("d")]);
    seedCheckIns("d", [shift(TODAY, -95)]);
    fakeRedis.seed(`${U}:reflection:d:${shift(TODAY, -91)}`, {
      text: "Wrote this the next morning",
      savedAt: new Date(`${windowStart}T18:00:00Z`).getTime(),
    });

    const history = (await getGoalHistories(U)).find((h) => h.goal.id === "d")!;

    expect(history.reflections[windowStart]).toBe("Wrote this the next morning");
  });
});
