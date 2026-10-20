// Pure `YYYY-MM-DD` arithmetic, with no Redis and no notion of "now". It lives here rather than
// in lib/kv.ts because the nudge schedule (lib/nudges.ts) needs it too, and lib/kv.ts imports
// *from* lib/nudges.ts - so anything both of them use has to sit below the pair.
//
// Every date in this app is a PST calendar date rendered as a string. These helpers work on the
// string, stepping through UTC noon so a day's worth of arithmetic can never be tipped over a
// boundary by a daylight-saving shift.

export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12));
  return [dt.getUTCFullYear(), String(dt.getUTCMonth() + 1).padStart(2, "0"), String(dt.getUTCDate()).padStart(2, "0")].join("-");
}

/** 0=Sun…6=Sat, matching Goal.nudgeDays. */
export function dayOfWeek(dateStr: string): number {
  return new Date(dateStr + "T12:00:00").getDay();
}

/**
 * The ISO-8601 week a date belongs to: weeks run Monday–Sunday and week 1 is the one containing
 * Jan 4, so the year here is the *ISO* year - Mon Dec 29 2025 is "2026-W01".
 *
 * This is the one definition of a week key in the app. `getWeekKey` in lib/kv.ts is this plus a
 * default of "today in PST", and the notes page and the vacation planner call it directly - a
 * client-side copy of this arithmetic drifted out of step with the stored notes once already.
 */
export function weekKeyForDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);

  // Step to the Thursday of this date's week: the ISO year and week are whichever ones own that
  // Thursday, which is what makes the year-boundary cases fall out for free.
  const thursday = new Date(Date.UTC(y, m - 1, d));
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const isoYear = thursday.getUTCFullYear();

  const week1Thursday = new Date(Date.UTC(isoYear, 0, 4));
  week1Thursday.setUTCDate(week1Thursday.getUTCDate() - ((week1Thursday.getUTCDay() + 6) % 7) + 3);

  const week = Math.round((thursday.getTime() - week1Thursday.getTime()) / (7 * 86400000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** The Monday that starts a week key - the inverse of `weekKeyForDate`. */
export function mondayOfWeekKey(weekKey: string): string {
  const [year, weekStr] = weekKey.split("-W");
  const jan4 = new Date(Date.UTC(Number(year), 0, 4));
  const firstMonday = new Date(jan4);
  firstMonday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  firstMonday.setUTCDate(firstMonday.getUTCDate() + (Number(weekStr) - 1) * 7);
  return firstMonday.toISOString().slice(0, 10);
}

/** Every ISO week a date range touches, in order, including partial weeks at either end. */
export function weeksInRange(startDate: string, endDate: string): string[] {
  const weeks: string[] = [];
  for (let date = startDate; date <= endDate; date = addDaysToDateStr(date, 1)) {
    const week = weekKeyForDate(date);
    if (weeks[weeks.length - 1] !== week) weeks.push(week);
  }
  return weeks;
}
