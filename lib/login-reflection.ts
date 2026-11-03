import type { GoalStatus } from "./types";

/**
 * Which habit the tracker asks about when its page opens.
 *
 * List order, so the sheet matches the page. A graduated habit has nothing to
 * account for. An id in `answered` was saved earlier this visit and must not
 * be asked again while the refreshed list is still catching up.
 */
export function pickLoginReflection(
  goals: GoalStatus[],
  answered: ReadonlySet<string> = new Set()
): GoalStatus | null {
  return (
    goals
      .filter((g) => !g.graduatedAt && g.reflection && !answered.has(g.id))
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))[0] ?? null
  );
}

export type LoginPromptState = {
  /** This visit already offered a prompt, or opened with nothing waiting. */
  settled: boolean;
  /** A reflection was just saved, so the next waiting habit should open. */
  advance: boolean;
};

/**
 * The prompt to open now, if any.
 *
 * One sheet per visit. Closing it settles the visit, so a later refresh does
 * not raise the same question again. Saving advances, because the person is
 * working through the ones that are waiting.
 */
export function loginReflectionToShow(
  goals: GoalStatus[],
  state: LoginPromptState,
  answered: ReadonlySet<string> = new Set()
): GoalStatus | null {
  if (state.settled && !state.advance) return null;
  return pickLoginReflection(goals, answered);
}
