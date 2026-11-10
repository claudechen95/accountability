import { describe, expect, it } from "vitest";
import {
  loginReflectionToShow,
  pickLoginReflection,
  reflectionSheetDates,
  sameReflectionPrompt,
} from "@/lib/login-reflection";
import type { GoalStatus, ReflectionPrompt } from "@/lib/types";

const missed: ReflectionPrompt = {
  reason: "missed-day",
  dates: ["2026-08-25"],
  required: true,
};

function goal(partial: Partial<GoalStatus> & Pick<GoalStatus, "id">): GoalStatus {
  return {
    name: partial.id,
    emoji: "🥗",
    frequency: "daily",
    targetCount: 1,
    completedThisPeriod: 0,
    todayCount: 0,
    isDone: false,
    periodTarget: 1,
    streak: 0,
    reflection: null,
    canGraduate: false,
    ...partial,
  };
}

describe("pickLoginReflection", () => {
  it("picks the first habit in list order that has something to ask", () => {
    const goals = [
      goal({ id: "later", order: 2, reflection: missed }),
      goal({ id: "first", order: 0, reflection: missed }),
      goal({ id: "quiet", order: 1 }),
    ];
    expect(pickLoginReflection(goals)?.id).toBe("first");
  });

  it("still asks after today's check-in, since the question is about an earlier miss", () => {
    const goals = [goal({ id: "done-today", todayCount: 1, isDone: true, reflection: missed })];
    expect(pickLoginReflection(goals)?.id).toBe("done-today");
  });

  it("skips a graduated habit and one already answered this visit", () => {
    const goals = [
      goal({ id: "shelf", order: 0, graduatedAt: "2026-08-01", reflection: missed }),
      goal({ id: "saved", order: 1, reflection: missed }),
      goal({ id: "next", order: 2, reflection: missed }),
    ];
    expect(pickLoginReflection(goals, new Set(["saved"]))?.id).toBe("next");
  });

  it("returns nothing when every habit is quiet", () => {
    expect(pickLoginReflection([goal({ id: "ok" })])).toBeNull();
  });
});

describe("loginReflectionToShow", () => {
  const waiting = [goal({ id: "a", order: 0, reflection: missed })];

  it("asks once when the page opens onto a waiting habit", () => {
    expect(loginReflectionToShow(waiting, { settled: false, advance: false })?.id).toBe("a");
  });

  it("stays quiet for the rest of the visit after the sheet is closed", () => {
    expect(loginReflectionToShow(waiting, { settled: true, advance: false })).toBeNull();
  });

  it("opens the next habit after one is saved", () => {
    const goals = [
      goal({ id: "saved", order: 0, reflection: missed }),
      goal({ id: "next", order: 1, reflection: missed }),
    ];
    expect(
      loginReflectionToShow(goals, { settled: true, advance: true }, new Set(["saved"]))?.id
    ).toBe("next");
  });
});

describe("sameReflectionPrompt", () => {
  const behind = {
    reason: "week-behind" as const,
    date: "2026-08-25",
    completed: 0,
    target: 5,
    daysLeft: 5,
    required: false,
  };

  it("treats the same reason and days as the same question when the counts move", () => {
    expect(sameReflectionPrompt(behind, { ...behind, completed: 1, daysLeft: 4 })).toBe(true);
    expect(sameReflectionPrompt(missed, { ...missed, required: false })).toBe(true);
  });

  it("does not match a question that is gone, or one about a different day", () => {
    expect(sameReflectionPrompt(behind, null)).toBe(false);
    expect(sameReflectionPrompt(null, behind)).toBe(false);
    expect(sameReflectionPrompt(behind, { ...behind, date: "2026-08-26" })).toBe(false);
    expect(sameReflectionPrompt(missed, { ...missed, dates: ["2026-08-24", "2026-08-25"] })).toBe(false);
  });

  it("sends the days the sheet named, and none when a weekly prompt has no day", () => {
    expect(reflectionSheetDates(missed)).toEqual(["2026-08-25"]);
    expect(reflectionSheetDates(behind)).toEqual(["2026-08-25"]);
    expect(reflectionSheetDates({ ...behind, date: null })).toEqual([]);
  });
});
