import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { fakeRedis } from "./redis-fake";
import { POST } from "@/app/api/nudge/dispatch/route";
import type { Goal } from "@/lib/types";

// End-to-end over the dispatch route, one simulated PST day at a time. The pure schedule maths
// is covered in nudges.test.ts; what's checked here is the part that only exists in the route -
// that the five steps fire once each, in order, and that the escape hatches escape exactly as
// much as they're supposed to.
//
// The clock is the input under test, so every tick is a real POST at a real (faked) system time
// rather than a time argument threaded in. That's the only way this exercises the same
// getPstTimeHHMM/getTodayDate path production runs on.

const { texts, calls, phone } = vi.hoisted(() => ({
  texts: [] as { to: string; body: string }[],
  calls: [] as { to: string; script: string }[],
  // Stands in for the person being called. `outcome` is what Twilio would report about the last
  // attempt, which is the only thing that decides whether the ladder rings again - so these
  // tests set it to drive the retry loop rather than mocking Twilio's HTTP shape.
  phone: { outcome: "missed" as "reached" | "missed" | "pending" },
}));

vi.mock("@/lib/sendblue", () => ({
  sendText: async (to: string, content: string) => {
    texts.push({ to, body: content });
  },
}));

vi.mock("@/lib/call", () => ({
  isCallConfigured: () => true,
  placeCall: async (to: string, script: string) => {
    calls.push({ to, script });
    return `CA${calls.length}`;
  },
  getCallOutcome: async () => phone.outcome,
}));

const TODAY = "2026-08-26"; // Wednesday, PDT (UTC-7)
const SECRET = "test-dispatch-secret";
const PHONE = "+15550000001";
const PARTNER = "+15550000002";

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fmt(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * One cron tick. `hhmm` past 24:00 rolls into the small hours of the next calendar day, which is
 * how a ladder belonging to TODAY gets ticked after midnight - the route has to work that out
 * for itself from the wall clock, exactly as it does in production.
 */
async function tickAt(hhmm: string) {
  const min = toMin(hhmm);
  // PDT is UTC-7, and Date handles the rollover into the next UTC day for evening PST times.
  vi.setSystemTime(new Date(Date.UTC(2026, 7, 26, 7 + Math.floor(min / 60), min % 60)));
  await POST(
    new Request("http://localhost/api/nudge/dispatch", {
      method: "POST",
      headers: { "x-nudge-secret": SECRET },
    })
  );
}

/**
 * Runs the real cron cadence and logs what went out. The window is round the clock because a
 * habit may nudge at any hour and its ladder can run an hour or so past midnight - the schedule
 * used to stop at 11pm, which silently dropped every step a late habit had after it.
 *
 * Ticks past midnight are logged as "24:10" rather than "00:10" so a transcript sorts and reads
 * in ladder order, which is the same reason lib/nudges.ts counts in minutes rather than clock
 * strings.
 */
async function runDay(untilHHMM = "26:00"): Promise<string[]> {
  const log: string[] = [];
  for (let m = toMin("08:00"); m <= toMin(untilHHMM); m += 10) {
    const at = fmt(m);
    const seen = { t: texts.length, c: calls.length };
    await tickAt(at);
    for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
    for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
  }
  return log;
}

function seedUser(overrides: Partial<{ phone: string; partnerPhone: string }> = {}) {
  fakeRedis.seed("users", [
    { id: "tester", label: "Tester", phone: PHONE, partnerPhone: PARTNER, ...overrides },
  ]);
}

const salad: Goal = {
  id: "salad",
  name: "Salad",
  emoji: "🥗",
  frequency: "daily",
  targetCount: 1,
  nudgeTime: "18:00",
};

beforeAll(() => {
  vi.useFakeTimers();
  process.env.NUDGE_DISPATCH_SECRET = SECRET;
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  fakeRedis.reset();
  texts.length = 0;
  calls.length = 0;
  phone.outcome = "missed";
  seedUser();
  fakeRedis.seed("tester:goals", [salad]);
});

describe("the nudge ladder over a full day", () => {
  it("sends three texts, calls three times, then tells the partner", async () => {
    expect(await runDay()).toEqual([
      `18:00 text→${PHONE}`,
      `19:20 text→${PHONE}`,
      `20:40 text→${PHONE}`,
      `20:50 call→${PHONE}`,
      `21:00 call→${PHONE}`,
      `21:10 call→${PHONE}`,
      `21:40 text→${PARTNER}`,
    ]);
  });

  it("says the habit out loud on the call", async () => {
    await runDay();
    expect(calls[0].script).toBe(
      "Hey Tester. This is your accountability check. You still have 1 habit open today: Salad. Open the app to check it off."
    );
  });

  it("stays silent all day once the habit is done", async () => {
    fakeRedis.seed(`tester:checkin:salad:${TODAY}`, 1);
    expect(await runDay()).toEqual([]);
  });

  it("stops at the calls when there's no partner to escalate to", async () => {
    seedUser({ partnerPhone: undefined });
    expect(await runDay()).toEqual([
      `18:00 text→${PHONE}`,
      `19:20 text→${PHONE}`,
      `20:40 text→${PHONE}`,
      `20:50 call→${PHONE}`,
      `21:00 call→${PHONE}`,
      `21:10 call→${PHONE}`,
    ]);
  });
});

// The reason step 4 retries at all: one ring is trivially declined, and being in a meeting is
// exactly when the call matters. Twilio reports a voicemail pickup as `completed`, identical to
// a human answering, so lib/call.ts leans on answering-machine detection to tell them apart -
// getCallOutcome collapses that to reached/missed/pending and this is what the route does with it.
describe("calling until someone picks up", () => {
  it("gives up after three attempts and hands over to the partner", async () => {
    const log = await runDay();
    expect(log.filter((l) => l.includes("call"))).toEqual([
      `20:50 call→${PHONE}`,
      `21:00 call→${PHONE}`,
      `21:10 call→${PHONE}`,
    ]);
  });

  it("stops calling once a person answers, and lets them off the partner alert", async () => {
    const log: string[] = [];
    for (let m = toMin("08:00"); m <= toMin("23:00"); m += 10) {
      const at = fmt(m);
      // The 20:50 call connects; every tick after that sees a reached call.
      if (at === "21:00") phone.outcome = "reached";
      const seen = { t: texts.length, c: calls.length };
      await tickAt(at);
      for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
      for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
    }
    // One call, and crucially no partner text - answering is a live acknowledgement, unlike a
    // snooze, so it ends the day for every habit at once.
    expect(log).toEqual([
      `18:00 text→${PHONE}`,
      `19:20 text→${PHONE}`,
      `20:40 text→${PHONE}`,
      `20:50 call→${PHONE}`,
    ]);
  });

  it("waits rather than redialling while the previous call is still ringing", async () => {
    phone.outcome = "pending";
    await tickAt("22:00");
    await tickAt("22:10");
    await tickAt("22:20");
    expect(calls).toHaveLength(1);

    // Once it resolves as missed, the ladder picks up where it left off instead of having
    // burned the attempts it spent waiting.
    phone.outcome = "missed";
    await tickAt("22:30");
    await tickAt("22:40");
    expect(calls).toHaveLength(3);
  });

  it("delays the partner alert to 30 min after the last call, not the first", async () => {
    const log = await runDay();
    expect(log).toContain(`21:10 call→${PHONE}`);
    expect(log).toContain(`21:40 text→${PARTNER}`);
    // 30 min after the *first* attempt would have been 21:20.
    expect(log).not.toContain(`21:20 text→${PARTNER}`);
  });
});

// Carriers intercept these ahead of Sendblue on SMS and block every future message from the
// sender permanently, without ever delivering the inbound webhook - so the ladder would keep
// calling and alerting the partner about texts that can no longer arrive. Nothing we send may
// invite one.
describe("carrier opt-out keywords", () => {
  // Sendblue's documented auto-detected set, plus the carrier-standard ones it doesn't list.
  const RESERVED = [
    "stop", "stopall", "unsubscribe", "cancel", "opt out", "revoke",
    "end", "quit", "start", "unstop",
  ];

  it("never instructs the user to send one", async () => {
    await runDay();
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      // Whole words only: "pending" legitimately contains "end".
      const used = RESERVED.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(t.body));
      expect(used, `"${t.body}" invites the reserved keyword(s) ${used.join(", ")}`).toEqual([]);
    }
  });

  // Naming a safe word matters more than it looks: "reply anything" is an invitation to
  // improvise, and "stop" or "cancel" are the obvious things to improvise.
  it("names a harmless word rather than inviting a free-form reply", async () => {
    await runDay();
    expect(texts[0].body).toContain(`Reply "pause" to mute these for today.`);
  });

  // "these", not "today's nudges": the reply only mutes the habits the text just listed, and
  // copy that promised the whole day would be quiet is how the scope confusion started.
  it("does not promise more quiet than a reply actually buys", async () => {
    await runDay();
    expect(texts[0].body).not.toContain("today's nudges");
  });
});

describe("muting a habit for the day", () => {
  // A mute is a full exit for that habit: no more texts, no call, and no partner alert either.
  // It is not a mute button that leaves the accountability running - the user answered, and
  // what they answered about is finished for the day.
  it("ends that habit's day outright, partner alert included", async () => {
    fakeRedis.seed(`tester:nudge:muted:salad:${TODAY}`, 1);
    expect(await runDay()).toEqual([]);
  });

  it("muting mid-evening drops the remaining texts, the call and the partner alert", async () => {
    const log: string[] = [];
    for (let m = toMin("08:00"); m <= toMin("23:00"); m += 10) {
      const at = fmt(m);
      if (at === "19:00") fakeRedis.seed(`tester:nudge:muted:salad:${TODAY}`, 1);
      const seen = { t: texts.length, c: calls.length };
      await tickAt(at);
      for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
      for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
    }
    expect(log).toEqual([`18:00 text→${PHONE}`]);
  });

  // The bug this scoping exists for, reproduced from the day it happened: a ⛰️ Nature nudge went
  // out at 11:00, "Pause" came back at 11:56, and 📝 Video Journal - whose nudge time is 21:00 and
  // which had therefore not said a word yet - went silent for the rest of the day.
  it("leaves a habit alone when it wasn't nudging yet at the time of the reply", async () => {
    fakeRedis.seed("tester:goals", [
      { ...salad, id: "nature", name: "Nature", nudgeTime: "11:00" },
      { ...salad, id: "journal", name: "Video Journal", nudgeTime: "21:00" },
    ]);
    const log: string[] = [];
    for (let m = toMin("08:00"); m <= toMin("23:00"); m += 10) {
      const at = fmt(m);
      // "Pause" at 11:56 answers the 11:00 Nature text, and nothing else - Video Journal's
      // ladder does not open until 21:00.
      if (at === "12:00") fakeRedis.seed(`tester:nudge:muted:nature:${TODAY}`, 1);
      const seen = { t: texts.length, c: calls.length };
      await tickAt(at);
      for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
      for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
    }
    expect(log).toEqual([
      `11:00 text→${PHONE}`, // Nature's first and only text
      `21:00 text→${PHONE}`, // Video Journal's ladder, untouched by the 11:56 reply
      `21:20 text→${PHONE}`,
      `21:40 text→${PHONE}`,
      `21:50 call→${PHONE}`,
      `22:00 call→${PHONE}`,
      `22:10 call→${PHONE}`,
      `22:40 text→${PARTNER}`,
    ]);
    // And the habit the user actually answered about is the only one left out of the alert.
    expect(texts.at(-1)!.body).toBe("📢 Tester didn't finish today: 🥗 Video Journal");
  });

  it("names only the still-live habits when several are running and one is muted", async () => {
    fakeRedis.seed("tester:goals", [
      { ...salad, id: "nature", name: "Nature", nudgeTime: "18:00" },
      { ...salad, id: "journal", name: "Video Journal", nudgeTime: "18:00" },
    ]);
    fakeRedis.seed(`tester:nudge:muted:nature:${TODAY}`, 1);
    await runDay();
    expect(texts[0].body).toContain("Video Journal");
    expect(texts[0].body).not.toContain("Nature");
    expect(calls[0].script).toContain("1 habit open today: Video Journal.");
  });
});

describe("per-habit scheduling", () => {
  // The headline of making calls per-habit: two habits on different clocks run two completely
  // independent ladders, and neither waits for the other.
  it("gives every habit its own texts and its own call ladder", async () => {
    fakeRedis.seed("tester:goals", [
      { ...salad, nudgeTime: "09:00" },
      { ...salad, id: "gym", name: "Gym", nudgeTime: "18:00" },
    ]);
    const log = await runDay();

    // Salad runs 09:00/13:20/17:40 then calls from 17:50; Gym runs 18:00/19:20/20:40 then calls
    // from 20:50. Gym is still sending its first text after Salad has already been called about.
    expect(log.filter((l) => l.includes(`text→${PHONE}`))).toHaveLength(6);
    expect(log).toContain(`09:00 text→${PHONE}`);
    expect(log).toContain(`17:50 call→${PHONE}`);
    expect(log).toContain(`18:00 text→${PHONE}`);
    expect(log).toContain(`20:50 call→${PHONE}`);

    // Each call names only the habit whose ladder reached it.
    expect(calls[0].script).toContain("1 habit open today: Salad.");
    expect(calls.at(-1)!.script).toContain("1 habit open today: Gym.");
  });

  // Regression: when the call was a single per-user ladder pinned near DAY_END, reaching that
  // cutoff short-circuited the text block, so a habit configured past it got neither a text nor
  // a call and went silent all day. Per-habit ladders remove the cutoff entirely.
  it("gives a habit configured past DAY_END a full ladder, not a truncated one", async () => {
    fakeRedis.seed("tester:goals", [{ ...salad, name: "Piano Session", nudgeTime: "22:30" }]);
    // Three texts at the 20-minute floor rather than the single reminder a closed span used to
    // collapse to, then its own call ladder, then the partner - the last two after midnight.
    expect(await runDay()).toEqual([
      `22:30 text→${PHONE}`,
      `22:50 text→${PHONE}`,
      `23:10 text→${PHONE}`,
      `23:20 call→${PHONE}`,
      `23:30 call→${PHONE}`,
      `23:40 call→${PHONE}`,
      `24:10 text→${PARTNER}`, // 00:10 the following morning
    ]);
  });

  it("lets a late habit text while an earlier one is already being called about", async () => {
    fakeRedis.seed("tester:goals", [
      { ...salad, nudgeTime: "18:00" },
      { ...salad, id: "piano", name: "Piano Session", nudgeTime: "22:30" },
    ]);
    const log = await runDay();
    expect(log).toContain(`20:50 call→${PHONE}`); // Salad's ladder
    expect(log).toContain(`22:30 text→${PHONE}`); // Piano's first text, long after
    expect(log).toContain(`23:20 call→${PHONE}`); // and its own ladder after that
  });

  it("merges habits whose calls fall due on the same tick into one call", async () => {
    fakeRedis.seed("tester:goals", [
      { ...salad, nudgeTime: "18:00" },
      { ...salad, id: "gym", name: "Gym", nudgeTime: "18:00" },
    ]);
    await runDay();
    // Dialling the same number twice on one tick would put the second call on a busy signal.
    expect(calls[0].script).toContain("2 habits open today: Salad, and Gym");
  });

  it("fits three texts in even when the habit starts at 9pm", async () => {
    fakeRedis.seed("tester:goals", [{ ...salad, nudgeTime: "21:00" }]);
    expect(await runDay()).toEqual([
      `21:00 text→${PHONE}`,
      `21:20 text→${PHONE}`,
      `21:40 text→${PHONE}`,
      `21:50 call→${PHONE}`,
      `22:00 call→${PHONE}`,
      `22:10 call→${PHONE}`,
      `22:40 text→${PARTNER}`,
    ]);
  });
});

// A habit can be set to nudge at any hour, so its ladder can outrun the calendar day that
// started it. The ladder is anchored to that nudge day rather than to whatever date the clock
// happens to show, which is what keeps the steps in order across midnight - and, just as
// importantly, keeps the *next* day from inheriting them.
describe("a ladder that runs past midnight", () => {
  const late = { ...salad, id: "journal", name: "Video Journal", nudgeTime: "23:30" };

  it("finishes the ladder it started, hours into the next date", async () => {
    fakeRedis.seed("tester:goals", [late]);
    expect(await runDay()).toEqual([
      `23:30 text→${PHONE}`,
      `23:50 text→${PHONE}`,
      `24:10 text→${PHONE}`, // 00:10 - the third text, on the next calendar date
      `24:20 call→${PHONE}`,
      `24:30 call→${PHONE}`,
      `24:40 call→${PHONE}`,
      `25:10 text→${PARTNER}`, // 01:10
    ]);
  });

  // The check the whole anchoring exists to make possible. Checking in at 23:55 belongs to the
  // 23:30 habit's own day, so the 00:20 call must not happen - reading "today" off the wall
  // clock after midnight would find a fresh, empty day and ring anyway.
  it("stops when the habit is checked in before midnight", async () => {
    fakeRedis.seed("tester:goals", [late]);
    const log: string[] = [];
    for (let m = toMin("23:00"); m <= toMin("26:00"); m += 10) {
      const at = fmt(m);
      if (at === "24:00") fakeRedis.seed(`tester:checkin:journal:${TODAY}`, 1);
      const seen = { t: texts.length, c: calls.length };
      await tickAt(at);
      for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
      for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
    }
    expect(log).toEqual([`23:30 text→${PHONE}`, `23:50 text→${PHONE}`]);
  });

  it("lets a reply after midnight end the ladder it was answering", async () => {
    fakeRedis.seed("tester:goals", [late]);
    const log: string[] = [];
    for (let m = toMin("23:00"); m <= toMin("26:00"); m += 10) {
      const at = fmt(m);
      // Muted under TODAY - the nudge day the ladder belongs to, not the date on the clock.
      if (at === "24:20") fakeRedis.seed(`tester:nudge:muted:journal:${TODAY}`, 1);
      const seen = { t: texts.length, c: calls.length };
      await tickAt(at);
      for (const t of texts.slice(seen.t)) log.push(`${at} text→${t.to}`);
      for (const c of calls.slice(seen.c)) log.push(`${at} call→${c.to}`);
    }
    expect(log).toEqual([`23:30 text→${PHONE}`, `23:50 text→${PHONE}`, `24:10 text→${PHONE}`]);
  });

  // The expensive way to get the lookback wrong: reconsider *every* habit missed yesterday once
  // the clock passes midnight. Their ladders are long finished and every slot reads as past, so
  // each would immediately owe a second partner alert for a day that already had one.
  it("doesn't reopen an ordinary evening habit's ladder after midnight", async () => {
    // Salad nudges at 18:00 and its ladder is done by 21:40. Run the whole day, then keep
    // ticking into the small hours.
    const log = await runDay();
    expect(log.filter((l) => l.includes(PARTNER))).toEqual([`21:40 text→${PARTNER}`]);
    expect(log.filter((l) => toMin(l.slice(0, 5)) >= toMin("24:00"))).toEqual([]);
  });

  it("starts the new day's ladder without help from the old one", async () => {
    fakeRedis.seed("tester:goals", [{ ...salad, nudgeTime: "09:00" }]);
    await runDay("26:00");
    const before = texts.length;
    // 09:00 the next morning: a fresh day, and the habit is pending again.
    await tickAt(`${24 + 9}:00`);
    expect(texts.length).toBe(before + 1);
  });
});

describe("idempotence", () => {
  // Overlapping or retried cron invocations are the reason every step claims its slot before
  // sending. Ten identical ticks at one slot time must produce exactly one message.
  it("never double-sends when the same tick is replayed", async () => {
    for (let i = 0; i < 10; i++) await tickAt("18:00");
    expect(texts).toHaveLength(1);

    // Each call attempt is claimed before dialling, so a replayed tick can't ring twice - and
    // the backoff keeps the next attempt from being pulled forward into the same minute.
    for (let i = 0; i < 10; i++) await tickAt("22:00");
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 10; i++) await tickAt("22:10");
    expect(calls).toHaveLength(2);
    for (let i = 0; i < 10; i++) await tickAt("22:20");
    expect(calls).toHaveLength(3);

    for (let i = 0; i < 10; i++) await tickAt("22:50");
    expect(texts.filter((t) => t.to === PARTNER)).toHaveLength(1);
  });

  it("rejects a tick without the shared secret", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 1, 0))); // 18:00 PDT
    const res = await POST(new Request("http://localhost/api/nudge/dispatch", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(texts).toHaveLength(0);
  });
});
