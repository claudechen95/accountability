import type { NudgeCandidate } from "./types";
import { addDaysToDateStr, dayOfWeek } from "./dates";

// The escalation ladder for one unfinished habit, per day:
//   1-3. three texts, spread evenly from the habit's nudgeTime toward DAY_END
//   4.   a phone call ladder, starting a tick after that habit's last text
//   5.   a text to the user's accountability partner, PARTNER_ALERT_DELAY_MIN after the last call
// Everything here is pure - the weekday, clock, and habit list are passed in - so the dispatch
// route (app/api/nudge/dispatch/route.ts) and the inbound reply handler
// (app/api/nudge/inbound/route.ts) can share it without either one owning the clock.
//
// ## Why minutes, not "HH:MM"
//
// Every time in here is an integer count of minutes from **midnight of the habit's nudge day**,
// and it is allowed to exceed MINUTES_PER_DAY: a habit that starts nudging at 23:30 has its
// third text at 1450 and its partner alert at 1540, both of which fall on the following calendar
// date while still belonging to the evening that started them.
//
// This used to be "HH:MM" strings compared with `>=`, which cannot express that at all. A time
// past midnight wrapped round to a small number and therefore sorted *before* every other time
// in the ladder, so `now >= deadline` silently never fired and a late habit's escalation simply
// evaporated at 00:00. Minutes make the overhang representable; the dispatch route turns it into
// real clock time by running a second pass anchored on yesterday (see CARRYOVER_WINDOW_MIN).

export const DEFAULT_NUDGE_TIME = "21:00";

// The boundary nudgeSlots divides the texting span toward for any habit early enough to leave
// room before it. Habits configured later than this get MIN_SLOT_GAP_MIN spacing instead.
export const DAY_END = "22:00";

// The tightest the three texts may ever be packed. It's also exactly the spacing a 21:00 habit
// has always had (21:00 / 21:20 / 21:40), which is what makes extending the span past DAY_END
// for late habits a pure addition: every habit at or before 21:00 keeps the schedule it had.
//
// Without a floor, the span shrinks to nothing as the nudge time approaches DAY_END - a 21:50
// habit would text at 21:50, 21:53 and 21:57, which is three notifications in seven minutes and
// then a phone call, and a 22:00 one had no span at all and fell back to a single reminder.
export const MIN_SLOT_GAP_MIN = 20;

// How long after the day's last text before the phone rings. One cron tick: long enough that a
// text can be acted on first, short enough that the escalation still reads as a consequence of
// that text rather than an unrelated event later in the evening.
export const ESCALATION_DELAY_MIN = 10;

export const NUDGE_TEXT_COUNT = 3;

// Step 4 is up to this many calls, not one: a single ring is easy to decline in a meeting, and
// declining is precisely the case the call exists for.
export const MAX_CALL_ATTEMPTS = 3;

// The gap between call attempts. Retries have to land on cron ticks to happen at all, so this is
// quantised to the 10-minute tick rate - a shorter backoff would simply round up to it.
export const CALL_RETRY_MIN = 10;

// How long after the ladder's last call the user has to finish before their partner is told.
export const PARTNER_ALERT_DELAY_MIN = 30;

export const MINUTES_PER_DAY = 24 * 60;

// How far past midnight the dispatch route keeps looking back at yesterday's ladders. A habit
// can only overhang by so much - the worst case is nudging at 23:59, whose partner alert lands
// at 01:39 - and the retry backoff can stretch that when dispatch has been down, so this is a
// deliberately generous bound rather than a tight one. It decides two things that must agree:
// how long a nudge claim has to survive (lib/kv.ts's nudgeClaimTtl) and when the second pass
// stops running.
export const CARRYOVER_WINDOW_MIN = 3 * 60;

/**
 * One nudge day under evaluation, with the clock expressed in that day's own minutes.
 *
 * `carryover` marks the pass for a day that has already ended on the calendar. Only habits whose
 * ladder actually overhangs midnight are still in play on it - without that filter every habit
 * missed yesterday would be reconsidered after midnight and, with nowMin past all of its slots,
 * would immediately owe a partner alert for a day that already had one.
 */
export interface NudgeAnchor {
  date: string;
  dow: number;
  nowMin: number;
  carryover: boolean;
}

/**
 * Today always, plus yesterday while any of its ladders could still be running.
 *
 * This is the whole mechanism by which a ladder outlives midnight: rather than teaching every
 * step about dates, the tick is simply asked twice, and the second pass measures time from
 * yesterday's midnight so 00:20 reads as 1460. The lookback is bounded by CARRYOVER_WINDOW_MIN,
 * so for all but ~3 hours of the day this returns a single anchor and costs nothing.
 *
 * Shared by the dispatch tick and the inbound reply handler, which must agree on what "currently
 * nudging" means - a reply at 00:15 is an answer to the text that went out at 00:10, and the
 * handler can only see that habit if it looks at the same two days the sender did.
 */
export function nudgeAnchors(nowMin: number, today: string): NudgeAnchor[] {
  const anchors: NudgeAnchor[] = [
    { date: today, dow: dayOfWeek(today), nowMin, carryover: false },
  ];
  if (nowMin < CARRYOVER_WINDOW_MIN) {
    const yesterday = addDaysToDateStr(today, -1);
    anchors.push({
      date: yesterday,
      dow: dayOfWeek(yesterday),
      nowMin: nowMin + MINUTES_PER_DAY,
      carryover: true,
    });
  }
  return anchors;
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** For logs and call scripts only - never for comparisons, which is what the minutes are for. */
export function formatHHMM(minutes: number): string {
  const m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * The three text sends for one habit, as minutes from its nudge day's midnight.
 *
 * Deriving the times from the habit rather than from the dispatch tick is what guarantees
 * exactly three reminders before the call however the habit is configured: set to 9am they land
 * 4h20m apart, set to 9pm 20 minutes apart, set to 11:30pm 20 minutes apart with the last one
 * falling after midnight.
 */
export function nudgeSlots(nudgeTime?: string): number[] {
  const start = toMinutes(nudgeTime ?? DEFAULT_NUDGE_TIME);
  // Spread toward the day's end, but never tighter than MIN_SLOT_GAP_MIN - which for a habit
  // configured close to (or past) DAY_END means running on into the next calendar day rather
  // than compressing three reminders into a few minutes or collapsing them into one.
  const end = Math.max(toMinutes(DAY_END), start + NUDGE_TEXT_COUNT * MIN_SLOT_GAP_MIN);
  const step = (end - start) / NUDGE_TEXT_COUNT;
  return Array.from({ length: NUDGE_TEXT_COUNT }, (_, i) => Math.round(start + i * step));
}

/**
 * Every slot whose time has passed, not just the most recent one. A dispatch outage that skips
 * a tick therefore burns the slots it missed rather than replaying them one per later tick,
 * which would stretch a habit's three reminders past the call they're supposed to precede.
 */
export function dueSlotIndices(slots: number[], nowMin: number): number[] {
  return slots.flatMap((at, i) => (nowMin >= at ? [i] : []));
}

/**
 * When *this habit's* calls begin: one tick after its own last text, so a text always gets a
 * chance to be acted on before the phone rings for it. Per-habit rather than per-user, exactly
 * like the text slots - a habit's escalation is a consequence of its own reminders going
 * unanswered, and shouldn't wait on an unrelated habit that nudges later in the evening.
 */
export function habitCallStart(nudgeTime?: string): number {
  const slots = nudgeSlots(nudgeTime);
  return slots[slots.length - 1] + ESCALATION_DELAY_MIN;
}

/**
 * The latest minute this habit's ladder can reach if nothing is delayed - the last call attempt
 * plus the partner-alert wait. Used only to decide whether a ladder overhangs midnight and so
 * needs yesterday's pass; the real end can be later, which CARRYOVER_WINDOW_MIN allows for.
 */
export function ladderEnd(nudgeTime?: string): number {
  return (
    habitCallStart(nudgeTime) +
    (MAX_CALL_ATTEMPTS - 1) * CALL_RETRY_MIN +
    PARTNER_ALERT_DELAY_MIN
  );
}

/** True when this habit's ladder runs past midnight into the next calendar date. */
export function crossesMidnight(nudgeTime?: string): boolean {
  return ladderEnd(nudgeTime) >= MINUTES_PER_DAY;
}

/**
 * When the next call attempt is due, or null once the attempts are spent. Measured from when the
 * previous call actually went out rather than from a fixed timetable, so a dispatch outage delays
 * the ladder instead of silently burning the attempts it slept through - the opposite of
 * dueSlotIndices, because a text slot missed is a reminder lost, while a call attempt missed is
 * a chance to reach someone that's still worth taking late.
 */
export function nextCallTime(
  attemptsMade: number,
  lastCallMin: number | null,
  callStart: number
): number | null {
  if (attemptsMade >= MAX_CALL_ATTEMPTS) return null;
  if (attemptsMade === 0 || lastCallMin == null) return callStart;
  return lastCallMin + CALL_RETRY_MIN;
}

// Spoken word-for-word by the escalation call. Habit names only: emoji read badly in
// text-to-speech, coming out either skipped or narrated ("weight lifter, Gym session").
export function callScript(label: string, habitNames: string[]): string {
  const n = habitNames.length;
  const list =
    n > 1 ? `${habitNames.slice(0, -1).join(", ")}, and ${habitNames[n - 1]}` : habitNames[0];
  return (
    `Hey ${label}. This is your accountability check. ` +
    `You still have ${n} habit${n === 1 ? "" : "s"} open today: ${list}. ` +
    `Open the app to check ${n === 1 ? "it" : "them"} off.`
  );
}

/**
 * The single source of truth for "is this habit still pending" - the text dispatch, the call,
 * the partner alert, and the inbound reply handler all run off it, so they can't disagree.
 *
 * `dow` and `nowMin` belong to the habit's *nudge day*, which after midnight is not the current
 * calendar day: at 00:20 a ladder anchored on yesterday is evaluated with yesterday's weekday
 * and a nowMin of 1460, so a 22:30 habit reads as 1350 <= 1460 and stays pending rather than
 * being gated back out for not having reached its own start time yet.
 */
export function getPendingNudges<T extends NudgeCandidate>(goals: T[], dow: number, nowMin: number): T[] {
  return goals.filter((g) => {
    // Graduated habits aren't tracked any more, so they're never pending. (getGoalStatuses
    // already reports them as complete, which would exclude them anyway - this is the explicit
    // statement of why, so the reason survives any change to how a graduated status is shaped.)
    if (g.graduatedAt) return false;

    // A habit doesn't enter the ladder until its configured reminder time has passed for the
    // day - that time is also its first text slot (see nudgeSlots).
    if (toMinutes(g.nudgeTime ?? DEFAULT_NUDGE_TIME) > nowMin) return false;

    if (g.frequency === "daily") {
      return g.nudgeEnabled !== false && g.completedThisPeriod < g.targetCount;
    }
    if (g.nudgeDays && g.nudgeDays.includes(dow)) {
      return g.completedThisPeriod < g.targetCount && g.todayCount === 0;
    }
    return false;
  });
}
