import { describe, it, expect } from "vitest";
import {
  getPendingNudges,
  habitCallStart,
  nudgeSlots,
  dueSlotIndices,
  callScript,
  nextCallTime,
  ladderEnd,
  crossesMidnight,
  nudgeAnchors,
  toMinutes,
  formatHHMM,
  DAY_END,
  MINUTES_PER_DAY,
  MIN_SLOT_GAP_MIN,
  MAX_CALL_ATTEMPTS,
  CARRYOVER_WINDOW_MIN,
} from "@/lib/nudges";
import type { GoalStatus } from "@/lib/types";

// getPendingNudges is the single source of truth for "is this habit still pending" - the text
// dispatch, the escalation call, the partner alert, and the inbound reply handler all run off
// it, so they can't disagree. It's pure by design: the weekday and clock are passed in rather
// than read from the environment.
//
// Times are minutes from midnight of the habit's *nudge day* and may exceed MINUTES_PER_DAY -
// see the header of lib/nudges.ts for why they can't be "HH:MM" strings. These tests read them
// back through formatHHMM, since "23:30" is a great deal easier to check than 1410.

function status(overrides: Partial<GoalStatus> & Pick<GoalStatus, "id">): GoalStatus {
  return {
    name: overrides.id,
    emoji: "x",
    frequency: "daily",
    targetCount: 1,
    completedThisPeriod: 0,
    isDone: false,
    streak: 0,
    todayCount: 0,
    reflection: null,
    canGraduate: false,
    ...overrides,
  } as GoalStatus;
}

const WED = 3;
const ids = (goals: GoalStatus[]) => goals.map((g) => g.id);
/** Slot/call times as clock strings, so an assertion reads like the transcript it describes. */
const clock = (minutes: number[]) => minutes.map(formatHHMM);
const at = toMinutes;

describe("getPendingNudges", () => {
  it("holds a habit back until its nudge time has passed", () => {
    const g = status({ id: "a", nudgeTime: "18:00" });
    expect(ids(getPendingNudges([g], WED, at("17:59")))).toEqual([]);
    expect(ids(getPendingNudges([g], WED, at("18:00")))).toEqual(["a"]);
  });

  it("defaults an unset nudge time to 21:00", () => {
    const g = status({ id: "a" });
    expect(ids(getPendingNudges([g], WED, at("20:59")))).toEqual([]);
    expect(ids(getPendingNudges([g], WED, at("21:00")))).toEqual(["a"]);
  });

  // The clock is measured from the nudge day's midnight, so a ladder still running after
  // midnight passes a nowMin past MINUTES_PER_DAY and its habit stays pending - rather than
  // being gated back out for not having reached its own 23:30 start "yet".
  it("keeps a late habit pending after midnight, on the day it started", () => {
    const g = status({ id: "a", nudgeTime: "23:30" });
    expect(ids(getPendingNudges([g], WED, MINUTES_PER_DAY + at("00:20")))).toEqual(["a"]);
  });

  it("drops a daily habit that has met its target", () => {
    const done = status({ id: "a", completedThisPeriod: 1, targetCount: 1 });
    expect(ids(getPendingNudges([done], WED, at("21:00")))).toEqual([]);
  });

  it("respects an explicit opt-out on a daily habit", () => {
    const off = status({ id: "a", nudgeEnabled: false });
    expect(ids(getPendingNudges([off], WED, at("21:00")))).toEqual([]);
  });

  it("only nudges a weekly habit on its configured days", () => {
    const g = status({ id: "a", frequency: "weekly", targetCount: 3, nudgeDays: [1, WED] });
    expect(ids(getPendingNudges([g], WED, at("21:00")))).toEqual(["a"]);
    expect(ids(getPendingNudges([g], 2, at("21:00")))).toEqual([]); // Tuesday isn't in the list
  });

  it("drops a weekly habit already checked in today, even with the week's target unmet", () => {
    const g = status({
      id: "a",
      frequency: "weekly",
      targetCount: 3,
      completedThisPeriod: 1,
      todayCount: 1,
      nudgeDays: [WED],
    });
    expect(ids(getPendingNudges([g], WED, at("21:00")))).toEqual([]);
  });

  it("never nudges a graduated habit, which is no longer tracked", () => {
    const g = status({ id: "a", graduatedAt: "2026-08-01", graduatedRun: 40 });
    expect(ids(getPendingNudges([g], WED, at("21:00")))).toEqual([]);
  });
});

// The point of deriving slot times from the habit instead of from the cron tick: every habit
// gets exactly three texts before the call, however early or late it starts.
describe("nudgeSlots", () => {
  it("spreads three texts evenly from the nudge time to the day's end", () => {
    expect(clock(nudgeSlots("09:00"))).toEqual(["09:00", "13:20", "17:40"]);
    expect(clock(nudgeSlots("18:00"))).toEqual(["18:00", "19:20", "20:40"]);
  });

  it("compresses rather than dropping reminders when the nudge time is late", () => {
    expect(clock(nudgeSlots("21:00"))).toEqual(["21:00", "21:20", "21:40"]);
  });

  it("defaults an unset nudge time to 21:00, matching getPendingNudges", () => {
    expect(nudgeSlots(undefined)).toEqual(nudgeSlots("21:00"));
  });

  // Habits at or before 21:00 divide the span to DAY_END; later ones would divide a span that
  // has closed, so they take MIN_SLOT_GAP_MIN spacing and run on past it instead. The floor is
  // set to exactly a 21:00 habit's spacing, which is what makes the two rules meet without a
  // step: nothing at or before 21:00 changed when late times were allowed.
  it("hands every habit at or before 21:00 the schedule it has always had", () => {
    for (const start of ["08:00", "11:37", "14:05", "18:00", "21:00"]) {
      const slots = nudgeSlots(start);
      expect(slots).toHaveLength(3);
      expect(formatHHMM(slots[0])).toBe(start);
      expect(slots[2]).toBeLessThan(at(DAY_END));
    }
  });

  it("never packs the three texts closer than the floor, however late the habit", () => {
    for (const start of ["21:00", "21:30", "21:50", "22:00", "22:30", "23:30", "23:55"]) {
      const slots = nudgeSlots(start);
      expect(slots).toHaveLength(3);
      expect(formatHHMM(slots[0])).toBe(start);
      expect(slots[1] - slots[0]).toBeGreaterThanOrEqual(MIN_SLOT_GAP_MIN);
      expect(slots[2] - slots[1]).toBeGreaterThanOrEqual(MIN_SLOT_GAP_MIN);
    }
  });

  // Previously these collapsed: 22:00 had no span left to divide and fell back to a single
  // reminder, and 21:50 crushed three texts into seven minutes before calling.
  it("gives a habit configured past the day's end three real texts, spilling past midnight", () => {
    expect(clock(nudgeSlots("22:00"))).toEqual(["22:00", "22:20", "22:40"]);
    expect(clock(nudgeSlots("23:30"))).toEqual(["23:30", "23:50", "00:10"]);
    // Minutes, not the clock face: the third text is on the next calendar date and has to sort
    // *after* the first two, which is the whole reason these aren't strings.
    expect(nudgeSlots("23:30")[2]).toBe(MINUTES_PER_DAY + 10);
  });
});

describe("dueSlotIndices", () => {
  const slots = nudgeSlots("18:00"); // 18:00, 19:20, 20:40

  it("reports nothing before the first slot and one slot at a time after", () => {
    expect(dueSlotIndices(slots, at("17:59"))).toEqual([]);
    expect(dueSlotIndices(slots, at("18:00"))).toEqual([0]);
    expect(dueSlotIndices(slots, at("19:19"))).toEqual([0]);
  });

  // A dispatch outage has to burn the slots it slept through, not replay them one per later
  // tick - that would push a habit's third reminder past the call it's meant to precede.
  it("reports every passed slot at once after an outage", () => {
    expect(dueSlotIndices(slots, at("20:45"))).toEqual([0, 1, 2]);
  });

  it("sees a past-midnight slot as due rather than as long overdue", () => {
    const late = nudgeSlots("23:30"); // 23:30, 23:50, 00:10
    expect(dueSlotIndices(late, MINUTES_PER_DAY + at("00:00"))).toEqual([0, 1]);
    expect(dueSlotIndices(late, MINUTES_PER_DAY + at("00:10"))).toEqual([0, 1, 2]);
  });
});

describe("callScript", () => {
  it("reads a single habit in the singular", () => {
    expect(callScript("Alan", ["Salad"])).toContain("1 habit open today: Salad.");
    expect(callScript("Alan", ["Salad"])).toContain("check it off");
  });

  it("reads a list with a spoken 'and' before the last habit", () => {
    const script = callScript("Alan", ["Gym session", "Salad", "7+ hr sleep"]);
    expect(script).toContain("3 habits open today: Gym session, Salad, and 7+ hr sleep.");
    expect(script).toContain("check them off");
  });
});

// Call attempts are scheduled off the previous attempt rather than off a fixed timetable, which
// is the opposite of dueSlotIndices and deliberate: a missed text slot is a reminder lost and
// replaying it late would crowd the call it's meant to precede, whereas a missed call attempt is
// a chance to reach someone that's still worth taking a tick late.
describe("nextCallTime", () => {
  it("puts the first call on the computed start rather than a fixed hour", () => {
    expect(nextCallTime(0, null, at("21:50"))).toBe(at("21:50"));
  });

  it("spaces retries by the backoff, measured from the last call", () => {
    expect(nextCallTime(1, at("21:50"), at("21:50"))).toBe(at("22:00"));
    expect(nextCallTime(2, at("22:00"), at("21:50"))).toBe(at("22:10"));
  });

  it("returns null once the attempts are spent, which is what hands over to the partner", () => {
    expect(nextCallTime(MAX_CALL_ATTEMPTS, at("22:10"), at("21:50"))).toBeNull();
  });

  it("delays rather than skips when dispatch was down for the scheduled attempt", () => {
    // Back after an outage: the second call goes out 10 minutes after the first actually
    // happened, not at the time it would have had the day run uninterrupted.
    expect(nextCallTime(1, at("22:40"), at("21:50"))).toBe(at("22:50"));
  });

  // The failure this whole minutes rewrite exists to kill. As strings, "23:55" + 10 wrapped to
  // "00:05", which sorts before every other time in the ladder - so the retry read as already
  // long past and the remaining attempts collapsed onto a single tick.
  it("keeps counting upward across midnight instead of wrapping to the small hours", () => {
    expect(nextCallTime(1, MINUTES_PER_DAY - 5, MINUTES_PER_DAY - 5)).toBe(MINUTES_PER_DAY + 5);
    expect(formatHHMM(MINUTES_PER_DAY + 5)).toBe("00:05");
  });
});

// Each habit's calls hang off its own last text, exactly like its text slots hang off its own
// nudge time - the escalation is a consequence of that habit's reminders going unanswered.
describe("habitCallStart", () => {
  it("fires one tick after the habit's third text", () => {
    expect(formatHHMM(habitCallStart("21:00"))).toBe("21:50"); // texts 21:00 / 21:20 / 21:40
    expect(formatHHMM(habitCallStart("18:00"))).toBe("20:50"); // texts 18:00 / 19:20 / 20:40
  });

  it("gives an early habit an early ladder, independent of any other habit", () => {
    expect(formatHHMM(habitCallStart("13:25"))).toBe("19:18");
  });

  it("defaults an unset nudge time to 21:00, matching getPendingNudges", () => {
    expect(habitCallStart(undefined)).toBe(habitCallStart("21:00"));
  });

  it("starts a late habit's ladder after its third text, even when that's tomorrow", () => {
    expect(habitCallStart("23:30")).toBe(MINUTES_PER_DAY + at("00:20"));
    expect(formatHHMM(habitCallStart("22:30"))).toBe("23:20");
  });
});

// Which habits the dispatch route has to keep looking at after midnight. Getting this wrong in
// the permissive direction is expensive: every habit missed yesterday would be reconsidered at
// 00:00 with its whole ladder already "past", and would owe an immediate second partner alert.
describe("crossesMidnight", () => {
  it("is false for every habit that finishes inside its own day", () => {
    for (const t of ["09:00", "18:00", "21:00", "21:30"]) {
      expect(crossesMidnight(t), t).toBe(false);
    }
    expect(ladderEnd("21:00")).toBeLessThan(MINUTES_PER_DAY);
  });

  it("is true once the partner alert lands on the next date", () => {
    // 22:30 texts to 23:10, calls from 23:20, and owes its partner at 00:10.
    expect(crossesMidnight("22:30")).toBe(true);
    expect(ladderEnd("22:30")).toBe(MINUTES_PER_DAY + at("00:10"));
  });

  it("stays inside the carryover window even at the latest configurable time", () => {
    // The bound the claim TTL and the lookback are both sized against: nothing may finish later.
    expect(ladderEnd("23:59")).toBeLessThan(MINUTES_PER_DAY + CARRYOVER_WINDOW_MIN);
  });
});

describe("nudgeAnchors", () => {
  it("is just today for most of the day, so the second pass costs nothing", () => {
    const anchors = nudgeAnchors(at("21:00"), "2026-08-26");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ date: "2026-08-26", carryover: false, nowMin: at("21:00") });
  });

  it("adds yesterday just after midnight, with the clock continuing past 1440", () => {
    const anchors = nudgeAnchors(at("00:20"), "2026-08-27");
    expect(anchors).toHaveLength(2);
    expect(anchors[1]).toMatchObject({
      date: "2026-08-26",
      carryover: true,
      nowMin: MINUTES_PER_DAY + at("00:20"),
    });
  });

  it("carries yesterday's weekday, not today's", () => {
    // Sun 2026-08-23, so the ladder still running belongs to Saturday.
    const [, yesterday] = nudgeAnchors(at("00:30"), "2026-08-23");
    expect(yesterday.dow).toBe(6);
  });

  it("stops looking back once the window has closed", () => {
    expect(nudgeAnchors(CARRYOVER_WINDOW_MIN, "2026-08-27")).toHaveLength(1);
  });
});
