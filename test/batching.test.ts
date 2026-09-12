/**
 * Round-trip counts for the page-load reads.
 *
 * Upstash is REST - every command is its own HTTPS request - so how slow a page feels is mostly
 * how many commands its route issues. That's a property no assertion on returned data can catch:
 * an N+1 returns exactly the right answer, just slowly, which is why `GET /api/goals` sat at 135
 * round trips for as long as it did. These tests assert the counts directly.
 *
 * The bounds are deliberately a little loose - they're there to catch a fan-out being
 * reintroduced (a `get` per day, an `lrange` per goal), not to pin an exact number that a benign
 * refactor would have to churn. A failure here means a loop started issuing commands again.
 *
 * Every test opens a cache scope with `runWithCache`, because that's what a real request does -
 * `withPerf` wraps every route handler and `measure` wraps the server components. Without a
 * scope the cache is a transparent passthrough, so these counts would be the un-deduped ones.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  getGoalStatuses,
  getGoalHistories,
  getAllMoodEntries,
  getAllWeeklyNotes,
  addCheckIn,
  getCheckInsForPeriod,
} from "@/lib/kv";
import { runWithCache } from "@/lib/request-cache";
import type { Goal } from "@/lib/types";
import { fakeRedis } from "./redis-fake";

// Wed 26 Aug 2026, 11:00 PDT - the same pinned clock the other data-layer suites use, so a
// weekly goal has both "still winnable" and "out of reach" cases available.
const NOW = new Date("2026-08-26T18:00:00Z");
const TODAY = "2026-08-26";
const U = "batchuser";

function shift(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

const daily = (id: string): Goal => ({ id, name: id, emoji: "x", frequency: "daily", targetCount: 1 });
const weekly = (id: string, target = 3): Goal => ({
  id,
  name: id,
  emoji: "x",
  frequency: "weekly",
  targetCount: target,
});

function setGoals(...goals: Goal[]) {
  fakeRedis.seed(`${U}:goals`, goals);
  for (const g of goals) {
    // getReflectionPrompt short-circuits on a habit with no check-in history at all, which would
    // skip the very reads these counts are about.
    fakeRedis.seedListEntry(`${U}:history:${g.id}`, { goalId: g.id, timestamp: 1, date: TODAY, week: "x" });
  }
}

/** Check the habit in on each of the last `days` days, ending yesterday. */
function seedDailyRun(goalId: string, days: number) {
  for (let i = 1; i <= days; i++) fakeRedis.seed(`${U}:checkin:${goalId}:${shift(TODAY, -i)}`, 1);
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => fakeRedis.reset());

describe("GET /api/goals read volume", () => {
  it("does not scale its round trips with the number of habits", async () => {
    const goals = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? daily(`d${i}`) : weekly(`w${i}`)));
    setGoals(...goals);
    for (const g of goals) seedDailyRun(g.id, 3);

    const commands = await fakeRedis.countCommands(() => runWithCache(() => getGoalStatuses(U)));

    // 12 habits × 4 per-habit lookups was 135 commands. The fan-out is now: the goals key, one
    // pipelined llen batch, one current-period mget, and a streak block per habit.
    expect(commands).toBeLessThan(25);
  });

  it("reads the vacation window once, not once per habit per caller", async () => {
    const goals = Array.from({ length: 8 }, (_, i) => weekly(`w${i}`));
    setGoals(...goals);

    await runWithCache(() => getGoalStatuses(U));

    // getDailyStreak, getWeeklyStreak and getReflectionPrompt each wanted this key, per habit -
    // 26 reads of one small key in the measured request that started all this.
    const vacationReads = fakeRedis.calls.filter((c) => c.includes("settings:vacation"));
    expect(vacationReads).toHaveLength(1);
  });

  it("asks for each habit's history length in a single pipeline", async () => {
    setGoals(...Array.from({ length: 6 }, (_, i) => daily(`d${i}`)));

    await runWithCache(() => getGoalStatuses(U));

    expect(fakeRedis.calls.filter((c) => c.startsWith("llen"))).toHaveLength(0);
    expect(fakeRedis.calls.filter((c) => c.startsWith("pipeline"))).toHaveLength(1);
  });
});

describe("streak walks", () => {
  it("counts a streak longer than one read block", async () => {
    // 40 days crosses the first block (14) into the second (28).
    setGoals(daily("g"));
    seedDailyRun("g", 40);

    const [status] = await runWithCache(() => getGoalStatuses(U));

    expect(status.streak).toBe(40);
  });

  it("walks a long streak in a handful of round trips, not one per day", async () => {
    setGoals(daily("g"));
    seedDailyRun("g", 40);

    const commands = await fakeRedis.countCommands(() => runWithCache(() => getGoalStatuses(U)));

    // This was one `get` per day - 41 round trips for this habit alone, and 366 for a habit
    // whose streak never breaks.
    expect(commands).toBeLessThan(10);
  });

  it("counts a weekly streak that spans more than one read block", async () => {
    // 6 consecutive weeks at 3x/week crosses the first block of 4 weeks.
    setGoals(weekly("w", 3));
    for (let week = 1; week <= 6; week++) {
      for (let d = 0; d < 3; d++) {
        fakeRedis.seed(`${U}:checkin:w:${shift(TODAY, -(week * 7) + d)}`, 1);
      }
    }

    const [status] = await runWithCache(() => getGoalStatuses(U));

    expect(status.streak).toBeGreaterThanOrEqual(6);
  });
});

describe("GET /api/history read volume", () => {
  it("reads every habit's target history in one pipeline", async () => {
    setGoals(...Array.from({ length: 7 }, (_, i) => daily(`d${i}`)));
    for (let i = 0; i < 7; i++) {
      fakeRedis.seedListEntry(`${U}:target-history:d${i}`, {
        date: TODAY,
        at: 1,
        frequency: "daily",
        targetCount: 1,
        origin: "created",
      });
    }

    await runWithCache(() => getGoalHistories(U));

    // One `lrange` per habit was the last unbatched fan-out on this route. The remaining
    // lranges, if any, belong to other callers - the target histories are all in the pipeline.
    expect(fakeRedis.calls.filter((c) => c.includes("target-history"))).toEqual([
      expect.stringContaining("pipeline"),
    ]);
  });

  it("reuses the grid's check-in reads for the streak walk", async () => {
    setGoals(daily("g"));
    seedDailyRun("g", 30);

    await runWithCache(() => getGoalHistories(U));

    // The 91-day grid and the streak walk both want the recent days. Whichever asks first pays;
    // a repeated read of the same key means the cache stopped working.
    const reads = fakeRedis.calls.filter((c) => c.startsWith("get ") || c.startsWith("mget "));
    const keys = reads.flatMap((c) => c.slice(c.indexOf(" ") + 1).split(","));
    const checkinKeys = keys.filter((key) => key.includes(":checkin:"));
    expect(new Set(checkinKeys).size).toBe(checkinKeys.length);
  });
});

describe("list views", () => {
  it("reads all mood days in one pipeline rather than one lrange each", async () => {
    for (let i = 0; i < 20; i++) {
      fakeRedis.seedListEntry(`${U}:mood:${shift(TODAY, -i)}`, { mood: "ok", timestamp: i });
    }

    const commands = await fakeRedis.countCommands(() => runWithCache(() => getAllMoodEntries(90, U)));

    // A `keys` scan plus one pipeline. This was 1 + 54 sequential round trips for Alan.
    expect(commands).toBe(2);
  });

  it("reads all weekly notes in one mget rather than one get each", async () => {
    for (let i = 1; i <= 20; i++) {
      fakeRedis.seed(`${U}:note:2026-W${String(i).padStart(2, "0")}`, {
        week: `2026-W${String(i).padStart(2, "0")}`,
        weekLabel: "x",
        headline: "x",
        wentWell: [],
        didntGoWell: [],
        actionItems: [],
        updatedAt: 1,
      });
    }

    const commands = await fakeRedis.countCommands(() => runWithCache(() => getAllWeeklyNotes(52, U)));

    expect(commands).toBe(2); // the `keys` scan, then one mget
  });
});

describe("cache correctness", () => {
  it("sees a check-in written earlier in the same request", async () => {
    setGoals(daily("g"));

    const count = await runWithCache(async () => {
      // Populate the cache first, so a missing invalidation would be caught rather than masked
      // by the read simply happening to come first.
      await getCheckInsForPeriod("g", TODAY, U);
      await addCheckIn("g", TODAY, U);
      return getCheckInsForPeriod("g", TODAY, U);
    });

    expect(count).toBe(1);
  });

  it("does not leak cached reads between requests", async () => {
    setGoals(daily("g"));
    await runWithCache(() => getCheckInsForPeriod("g", TODAY, U));

    fakeRedis.seed(`${U}:checkin:g:${TODAY}`, 7);

    // A separate request must go back to Redis - the cache lives and dies with one request.
    expect(await runWithCache(() => getCheckInsForPeriod("g", TODAY, U))).toBe(7);
  });
});
