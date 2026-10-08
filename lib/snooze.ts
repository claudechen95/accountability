import { formatHHMM, maxSnoozeUntil, MINUTES_PER_DAY } from "./nudges";

/**
 * The whole grammar of a reply to a nudge text. Two shapes, and nothing else does anything:
 *
 *   "1 2 until 15:30"  a delay. Several numbers share one time, and several times can share one
 *                      reply ("1 until 15:30 and 2 until 4pm"). The ladder resumes afterwards,
 *                      partner alert included.
 *   "pause 1"          a deliberate skip. That habit is finished being asked about for the day:
 *                      no more texts, no call, and no partner alert - the same full exit as
 *                      answering the phone.
 *
 * Pause is here because a snooze needs a time the user intends to actually do the thing, and
 * "I'm not doing it today, on purpose" has no such time. Without it the only exits were checking
 * in and picking up the phone, so an intentional rest day was indistinguishable from ignoring
 * the app, and the only reply that fit was a time the user knew was a lie.
 *
 * It is a quiet exit, and knowingly so: the partner is not told that a paused habit went
 * unfinished. The scope is what keeps that honest - a pause only reaches habits that are nudging
 * when it arrives, so it can never silence a question that hasn't been asked yet.
 */
export const REPLY_HINT =
  `Snooze with the numbers and a time, e.g. "1 2 until 15:30", or "pause 1" to skip it today.`;

export interface SnoozeGroup {
  numbers: number[];
  /**
   * Clock minutes since midnight, 0–1439. One entry when the reply named am/pm or a 24-hour
   * time, two when an hour of 1–12 was written with no meridiem (3:30 is 03:30 or 15:30).
   */
  clockMins: number[];
}

/** One of the two commands, as the reply asked for it. */
export type NudgeReply =
  | { kind: "snooze"; groups: SnoozeGroup[] }
  /** Empty numbers means a bare "pause": every habit that is nudging right now. */
  | { kind: "pause"; numbers: number[] };

const FILLER = new Set([
  "snooze", "please", "the", "for", "me", "to", "at", "until", "till", "til",
  "and", "by", "around", "about", "a",
  // Enough of a sentence that "pause it today" and "pause all" read as the command they are.
  "it", "them", "all", "today", "tonight",
]);

const PAUSE_WORDS = new Set(["pause", "skip"]);

function tokenize(text: string): string[] {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/(\d{1,2}(?::\d{2})?)\s*([ap])\.?\s*m\.?/g, "$1$2m")
    .replace(/&/g, " and ")
    .replace(/["“”']/g, "")
    .replace(/[.,]/g, " ")
    .replace(/#/g, "");
  return normalized.split(/\s+/).filter(Boolean);
}

/**
 * Reads a reply into whichever of the two commands it is, or null for anything else - "ok", a
 * bare number, a time with no numbers.
 *
 * A clock time is what separates the two, because that's what the difference between them *is*:
 * a time means "later today", its absence means "not today". So "pause 1 until 4pm" is a snooze
 * and the word is treated as filler, rather than being rejected for naming both at once.
 */
export function parseNudgeReply(text: string): NudgeReply | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  if (tokens.some((t) => PAUSE_WORDS.has(t)) && !tokens.some((t) => parseTimeToken(t))) {
    return parsePause(tokens);
  }
  const groups = parseSnoozeGroups(tokens);
  return groups && { kind: "snooze", groups };
}

/** The numbers a pause named, or null if it was padded out with anything we can't read. */
function parsePause(tokens: string[]): NudgeReply | null {
  const numbers: number[] = [];
  for (const token of tokens) {
    if (PAUSE_WORDS.has(token) || FILLER.has(token)) continue;
    if (!/^\d{1,2}$/.test(token)) return null;
    const n = Number(token);
    if (n < 1) return null;
    numbers.push(n);
  }
  return { kind: "pause", numbers: Array.from(new Set(numbers)) };
}

function parseSnoozeGroups(tokens: string[]): SnoozeGroup[] | null {
  const groups: SnoozeGroup[] = [];
  let numbers: number[] = [];

  const closeGroup = (clockMins: number[]): boolean => {
    if (numbers.length === 0) return false;
    groups.push({ numbers: Array.from(new Set(numbers)), clockMins });
    numbers = [];
    return true;
  };

  for (const token of tokens) {
    if (FILLER.has(token) || PAUSE_WORDS.has(token)) continue;
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
 * The two sentences both confirmations end with: what the reply asked for that matched nothing,
 * and whether it left something still nudging. Shared so a pause and a snooze can't answer the
 * same two questions in two different voices.
 */
function replyTail({
  missedNumbers,
  leftOut,
}: {
  missedNumbers: number[];
  leftOut: boolean;
}): string[] {
  const parts: string[] = [];
  if (missedNumbers.length === 1) {
    parts.push(`No habit numbered ${missedNumbers[0]} is nudging right now.`);
  } else if (missedNumbers.length > 1) {
    parts.push(`No habits numbered ${missedNumbers.join(", ")} are nudging right now.`);
  }
  if (leftOut) parts.push("Anything you left out will keep nudging.");
  return parts;
}

/**
 * What goes back after a pause. Every habit it reached is named, because a pause is the one
 * command that buys silence: if it took something the user didn't mean, this line is the only
 * place they'd ever find out. "for today" is the honest extent - the mute is keyed to the nudge
 * day, so tomorrow's ladder starts as normal.
 */
export function pauseConfirmation({
  paused,
  missedNumbers,
  leftOut,
}: {
  paused: string[];
  missedNumbers: number[];
  leftOut: boolean;
}): string {
  const parts: string[] = [];
  if (paused.length > 0) {
    const back = paused.length === 1 ? "It's" : "They're";
    parts.push(`Paused for today: ${paused.join(", ")}. ${back} back tomorrow.`);
  }
  parts.push(...replyTail({ missedNumbers, leftOut }));
  if (parts.length === 0) return REPLY_HINT;
  const body = parts.join(" ");
  return paused.length > 0 ? `⏸️ ${body}` : body;
}

/**
 * What goes back after a snooze. `applied` is what was held and until when, `tooLate` the habits
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
  parts.push(...replyTail({ missedNumbers, leftOut }));
  if (parts.length === 0) return REPLY_HINT;
  const body = parts.join(" ");
  return applied.length > 0 ? `✅ ${body}` : body;
}
