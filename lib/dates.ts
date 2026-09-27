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
