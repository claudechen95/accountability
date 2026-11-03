import { describe, expect, it } from "vitest";
import { loginReflectionToShow, pickLoginReflection } from "@/lib/login-reflection";
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
