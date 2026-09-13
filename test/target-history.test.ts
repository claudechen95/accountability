import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { getTargetHistory, recordTargetChange } from "@/lib/kv";
import { POST, PATCH } from "@/app/api/goals/route";
import {
  buildTargetTrend,
  formatTarget,
  targetLevels,
  weeklyEquivalent,
} from "@/lib/target-history";
import type { Goal, TargetChange } from "@/lib/types";
import { fakeRedis } from "./redis-fake";

const NOW = new Date("2026-08-26T18:00:00Z"); // Wed 26 Aug 2026, 11:00 PDT — the suite-wide pin
const TODAY = "2026-08-26";
const U = "testuser";

function goal(over: Partial<Goal> = {}): Goal {
  return { id: "piano", name: "Piano Session", emoji: "🎹", frequency: "weekly", targetCount: 2, ...over };
}

function change(over: Partial<TargetChange> = {}): TargetChange {
  return { date: "2026-06-01", at: 1, frequency: "weekly", targetCount: 2, origin: "edited", ...over };
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  fakeRedis.reset();
});

describe("weeklyEquivalent", () => {
  // The whole reason for a per-week axis: 6x/week → daily is a habit getting harder, and raw
  // targetCount would draw it as 6 collapsing to 1.
  it("puts daily and weekly targets on one scale", () => {
    expect(weeklyEquivalent({ frequency: "weekly", targetCount: 6 })).toBe(6);
    expect(weeklyEquivalent({ frequency: "daily", targetCount: 1 })).toBe(7);
    expect(weeklyEquivalent({ frequency: "daily", targetCount: 2 })).toBe(14);
  });

  it("formats a target in its own units", () => {
    expect(formatTarget({ frequency: "weekly", targetCount: 3 })).toBe("3x/week");
    expect(formatTarget({ frequency: "daily", targetCount: 1 })).toBe("1x/day");
  });
});

describe("recordTargetChange", () => {
  it("records the starting target when a habit is created", async () => {
    await recordTargetChange(goal(), undefined, U);

    const history = await getTargetHistory("piano", U);
    expect(history).toEqual([
      { date: TODAY, at: NOW.getTime(), frequency: "weekly", targetCount: 2, origin: "created" },
    ]);
  });

  it("records nothing when an edit leaves the target alone", async () => {
    await recordTargetChange(goal(), undefined, U);
    await recordTargetChange(goal({ name: "Piano", nudgeTime: "20:00" }), goal(), U);

    expect(await getTargetHistory("piano", U)).toHaveLength(1);
  });

  it("records the new target on a change", async () => {
    await recordTargetChange(goal(), undefined, U);
    await recordTargetChange(goal({ targetCount: 3 }), goal(), U);

    const history = await getTargetHistory("piano", U);
    expect(history.map((h) => [h.targetCount, h.origin])).toEqual([
      [2, "created"],
      [3, "edited"],
    ]);
  });

  // Every habit that predates this feature has no history at all, so the first change has to
  // write down what it was changing *from* or the chart has nothing to step down from.
  it("backfills the previous target when a habit has no history yet", async () => {
    await recordTargetChange(goal({ targetCount: 3 }), goal({ targetCount: 2 }), U);

    const history = await getTargetHistory("piano", U);
    expect(history.map((h) => [h.targetCount, h.origin])).toEqual([
      [2, "backfilled"],
      [3, "edited"],
    ]);
  });

  // A migration can move a target without going through the API, which would otherwise leave the
  // log claiming a target the habit hasn't had for months.
  it("backfills when the log has drifted from the habit's actual target", async () => {
    await recordTargetChange(goal(), undefined, U);
    await recordTargetChange(goal({ targetCount: 5 }), goal({ targetCount: 4 }), U);

    const history = await getTargetHistory("piano", U);
    expect(history.map((h) => [h.targetCount, h.origin])).toEqual([
      [2, "created"],
      [4, "backfilled"],
      [5, "edited"],
    ]);
  });

  it("keeps each user's log to their own namespace", async () => {
    await recordTargetChange(goal(), undefined, U);
    expect(await getTargetHistory("piano", "someone-else")).toEqual([]);
  });
});

describe("goals route", () => {
  const req = (method: string, body: unknown) =>
    new Request(`http://localhost/api/goals?user=${U}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("logs a target change made through the API", async () => {
    await POST(req("POST", goal()));
    await POST(req("POST", goal({ targetCount: 4 })));

    const history = await getTargetHistory("piano", U);
    expect(history.map((h) => [h.targetCount, h.origin])).toEqual([
      [2, "created"],
      [4, "edited"],
    ]);
  });

  it("logs nothing for a drag-reorder", async () => {
    await POST(req("POST", goal()));
    await PATCH(req("PATCH", { orderedIds: ["piano"] }));

    expect(await getTargetHistory("piano", U)).toHaveLength(1);
  });
});

describe("buildTargetTrend", () => {
  it("shows nothing for a habit whose target never moved", () => {
    expect(buildTargetTrend([], TODAY)).toBeNull();
    expect(buildTargetTrend([change({ origin: "created" })], TODAY)).toBeNull();
  });

  it("builds one segment per target, the last running to today", () => {
    const trend = buildTargetTrend(
      [
        change({ date: "2026-05-01", targetCount: 1, origin: "created" }),
        change({ date: "2026-06-15", targetCount: 2 }),
        change({ date: "2026-08-01", targetCount: 3 }),
      ],
      TODAY
    )!;

    expect(trend.segments.map((s) => [s.start, s.end, s.label])).toEqual([
      ["2026-05-01", "2026-06-15", "1x/week"],
      ["2026-06-15", "2026-08-01", "2x/week"],
      ["2026-08-01", TODAY, "3x/week"],
    ]);
    expect(trend.domainStart).toBe("2026-05-01");
    expect(trend.domainEnd).toBe(TODAY);
    expect(trend.openStart).toBe(false);
    expect(trend.steps.map((s) => s.direction)).toEqual(["up", "up"]);
  });

  // A graduated habit's card stops at its graduation date, so its chart has to stop there too
  // rather than running three months further right than the grid above it.
  it("stops the line at the end date it is given", () => {
    const trend = buildTargetTrend(
      [
        change({ date: "2026-05-01", targetCount: 1, origin: "created" }),
        change({ date: "2026-06-15", targetCount: 2 }),
      ],
      "2026-07-20"
    )!;

    expect(trend.domainEnd).toBe("2026-07-20");
    expect(trend.segments[trend.segments.length - 1].end).toBe("2026-07-20");
  });

  it("never ends behind the last change, which would draw that segment backwards", () => {
    const trend = buildTargetTrend(
      [
        change({ date: "2026-05-01", targetCount: 1, origin: "created" }),
        change({ date: "2026-06-15", targetCount: 2 }),
      ],
      "2026-06-01"
    )!;

    expect(trend.domainEnd).toBe("2026-06-15");
  });

  // The date on a backfilled record is the date we noticed, not the date it started, so the line
  // before the first change has to be drawn as unknown rather than as a real start.
  it("leaves the run before a backfilled target open-ended", () => {
    const trend = buildTargetTrend(
      [
        change({ date: "2026-07-01", targetCount: 2, origin: "backfilled" }),
        change({ date: "2026-07-01", at: 2, targetCount: 4 }),
      ],
      TODAY
    )!;

    expect(trend.openStart).toBe(true);
    expect(trend.domainStart).toBe("2026-06-17"); // two weeks of lead-in before the change
    expect(trend.segments[0].start).toBe("2026-06-17");
  });

  it("reads a scaled-back target as a downward step", () => {
    const trend = buildTargetTrend(
      [
        change({ date: "2026-05-01", targetCount: 5, origin: "created" }),
        change({ date: "2026-07-01", targetCount: 3 }),
      ],
      TODAY
    )!;

    expect(trend.steps[0].direction).toBe("down");
    expect(trend.minPerWeek).toBe(3);
    expect(trend.maxPerWeek).toBe(5);
  });

  it("reads 6x/week → daily as a step up, not a collapse to 1", () => {
    const trend = buildTargetTrend(
      [
        change({ date: "2026-05-01", targetCount: 6, origin: "created" }),
        change({ date: "2026-07-01", frequency: "daily", targetCount: 1 }),
      ],
      TODAY
    )!;

    expect(trend.steps[0].direction).toBe("up");
    expect(trend.segments.map((s) => s.perWeek)).toEqual([6, 7]);
  });

  // Talking yourself up and back down in one sitting is not two weeks at 4x — it's no change.
  it("collapses several edits on the same day to the last one", () => {
    expect(
      buildTargetTrend(
        [
          change({ date: "2026-05-01", targetCount: 2, origin: "created" }),
          change({ date: "2026-07-01", at: 1, targetCount: 4 }),
          change({ date: "2026-07-01", at: 2, targetCount: 2 }),
        ],
        TODAY
      )
    ).toBeNull();

    const trend = buildTargetTrend(
      [
        change({ date: "2026-05-01", targetCount: 2, origin: "created" }),
        change({ date: "2026-07-01", at: 1, targetCount: 4 }),
        change({ date: "2026-07-01", at: 2, targetCount: 3 }),
      ],
      TODAY
    )!;
    expect(trend.segments.map((s) => s.targetCount)).toEqual([2, 3]);
  });

  it("labels each axis level with the most recent wording used at it", () => {
    const trend = buildTargetTrend(
      [
        change({ date: "2026-05-01", targetCount: 7, origin: "created" }),
        change({ date: "2026-06-01", targetCount: 3 }),
        change({ date: "2026-07-01", frequency: "daily", targetCount: 1 }),
      ],
      TODAY
    )!;

    expect(targetLevels(trend)).toEqual([
      { perWeek: 3, label: "3x/week" },
      { perWeek: 7, label: "1x/day" }, // 7x/week and 1x/day share a level; the newer wording wins
    ]);
  });
});
