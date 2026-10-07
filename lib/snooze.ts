import { formatHHMM, maxSnoozeUntil, MINUTES_PER_DAY } from "./nudges";

/**
 * How a nudge text tells the user to push a reminder back. The shape is the whole command:
 * habit numbers, then a clock time. Several numbers share one time ("1 2 until 15:30"), and
 * several times can share one reply ("1 until 15:30 and 2 until 4pm").
 *
 * There is no "pause". A reply that isn't this shape changes nothing.
 */
export const SNOOZE_HINT = `Snooze with the numbers and a time, e.g. "1 2 until 15:30".`;

export interface SnoozeGroup {
  numbers: number[];
  /**
   * Clock minutes since midnight, 0–1439. One entry when the reply named am/pm or a 24-hour
   * time, two when an hour of 1–12 was written with no meridiem (3:30 is 03:30 or 15:30).
   */
  clockMins: number[];
}

const FILLER = new Set([
  "snooze", "please", "the", "for", "me", "to", "at", "until", "till", "til",
  "and", "by", "around", "about", "a",
]);

/**
 * Reads a snooze reply into groups of habit numbers and a clock time.
 * Returns null for anything else, including "pause", "ok", a bare number, or a time with no numbers.
 */
export function parseSnoozeReply(text: string): SnoozeGroup[] | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/(\d{1,2}(?::\d{2})?)\s*([ap])\.?\s*m\.?/g, "$1$2m")
    .replace(/&/g, " and ")
    .replace(/["“”']/g, "")
    .replace(/[.,]/g, " ")
    .replace(/#/g, "");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const groups: SnoozeGroup[] = [];
  let numbers: number[] = [];

  const closeGroup = (clockMins: number[]): boolean => {
    if (numbers.length === 0) return false;
    groups.push({ numbers: Array.from(new Set(numbers)), clockMins });
    numbers = [];
    return true;
  };

  for (const token of tokens) {
    if (FILLER.has(token)) continue;
    const clockMins = parseTimeToken(token);
    if (clockMins) {
      if (!closeGroup(clockMins)) return null;
      continue;
    }
    if (/^\d{1,2}$/.test(token)) {
      const n = Number(token);
      if (n < 1) return null;
      numbers.push(n);
      continue;
    }
    return null;
  }

  // A trailing number never got a time, so the reply isn't the shape we asked for.
  if (numbers.length > 0 || groups.length === 0) return null;
  return groups;
}

/** "15:30" → [930], "3:30pm" → [930], "3:30" → [210, 930], "3pm" → [900]. Not a time → null. */
function parseTimeToken(token: string): number[] | null {
  const m = token.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? null : Number(m[2]);
  const mer = m[3] as "am" | "pm" | undefined;
  // A bare "2" is a habit number. A time needs a colon or an explicit am/pm.
  if (minute === null && !mer) return null;
  const min = minute ?? 0;
  if (min > 59) return null;

  if (mer) {
    if (hour < 1 || hour > 12) return null;
    const h = mer === "am" ? hour % 12 : (hour % 12) + 12;
    return [h * 60 + min];
  }
  if (hour > 23) return null;
  if (hour === 0 || hour > 12) return [hour * 60 + min];
  const am = (hour % 12) * 60 + min;
  return [am, am + 12 * 60];
}

/**
 * The soonest minute strictly after `nowMin` that matches one of the clock times.
 * `nowMin` is minutes from today's midnight (0–1439). The result is too, unless that time has
 * already passed today, in which case it falls on tomorrow and is ≥ 1440.
 */
export function soonestUntil(clockMins: number[], nowMin: number): number {
  let best = Infinity;
  for (const c of clockMins) {
    const at = c > nowMin ? c : c + MINUTES_PER_DAY;
    if (at < best) best = at;
  }
  return best;
}

/** Minutes from today's midnight → "20:30", or "01:00 tomorrow" once it has crossed midnight. */
export function formatSnoozeWhen(untilMin: number): string {
  const clock = formatHHMM(untilMin);
  return untilMin >= MINUTES_PER_DAY ? `${clock} tomorrow` : clock;
}

export interface SnoozeHold {
  /** Minutes from the nudge day's midnight - the frame the dispatch tick compares against. */
  until: number;
  /** The same instant from today's midnight, for formatSnoozeWhen. */
  wall: number;
  /** The requested time was later than the ladder can reach, so it was pulled back to `until`. */
  capped: boolean;
}

/**
 * The hold to write for one habit, or null when there's no room left to hold it at all.
 *
 * Two conversions happen here, and both are about frames of reference. A carryover anchor is
 * yesterday, so a wall-clock 01:00 today is minute 1500 on it - that's the frame every deadline
 * in the ladder is in. And the hold is clamped to maxSnoozeUntil, because a snooze is a delay and
 * a hold set past the end of the nudge day would be a silent exit instead: nothing would ever
 * clear it, so the calls and the partner alert it holds back would never happen. A request past
 * the cap is pulled back to it rather than refused - the user asked for as late as possible, and
 * that's what they get.
 *
 * Null means the cap is already behind us, which a late enough reply to a finished ladder can do.
 * Writing the hold anyway would be a no-op the confirmation would then lie about.
 */
export function snoozeHold(
  wallUntilMin: number,
  wallNowMin: number,
  carryover: boolean,
  nudgeTime?: string
): SnoozeHold | null {
  const offset = carryover ? MINUTES_PER_DAY : 0;
  const requested = wallUntilMin + offset;
  const until = Math.min(requested, maxSnoozeUntil(nudgeTime));
  const wall = until - offset;
  if (wall <= wallNowMin) return null;
  return { until, wall, capped: until < requested };
}

/**
 * What goes back to the user. `applied` is what was held and until when, `tooLate` the habits
 * there was no room left to hold, `missedNumbers` the numbers that match nothing nudging, and
 * `leftOut` whether anything pending went unnamed.
 *
 * A clamped time is called out rather than quietly substituted: the reply named one time and the
 * confirmation names another, so the difference has to be accounted for or it reads as a bug.
 */
export function snoozeConfirmation({
  applied,
  tooLate = [],
  missedNumbers,
  leftOut,
}: {
  applied: { label: string; when: string; capped?: boolean }[];
  tooLate?: string[];
  missedNumbers: number[];
  leftOut: boolean;
}): string {
  const parts: string[] = [];
  const labelsByWhen = new Map<string, string[]>();
  for (const { label, when } of applied) {
    const labels = labelsByWhen.get(when);
    if (labels) labels.push(label);
    else labelsByWhen.set(when, [label]);
  }
  labelsByWhen.forEach((labels, when) => {
    parts.push(`Snoozed until ${when}: ${labels.join(", ")}.`);
  });
  if (applied.some((a) => a.capped)) {
    parts.push("That's as late as tonight's nudges run.");
  }
  if (tooLate.length > 0) {
    parts.push(`Too late to snooze ${tooLate.join(", ")} tonight.`);
  }
  if (missedNumbers.length === 1) {
    parts.push(`No habit numbered ${missedNumbers[0]} is nudging right now.`);
  } else if (missedNumbers.length > 1) {
    parts.push(`No habits numbered ${missedNumbers.join(", ")} are nudging right now.`);
  }
  if (leftOut) parts.push("Anything you left out will keep nudging.");
  if (parts.length === 0) return SNOOZE_HINT;
  const body = parts.join(" ");
  return applied.length > 0 ? `✅ ${body}` : body;
}
