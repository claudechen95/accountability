import { describe, it, expect } from "vitest";
import {
  REPLY_HINT,
  formatSnoozeWhen,
  parseNudgeReply,
  pauseConfirmation,
  snoozeConfirmation,
  snoozeHold,
  soonestUntil,
} from "@/lib/snooze";

// The reply grammar. A nudge text asks for one of two answers - habit numbers with a clock time
// to delay them, or "pause" to skip them for the day - and this is the whole of what counts as
// either. Anything else is not an answer.
//
// A clock time is what tells them apart, and that's the distinction itself: a time means "later
// today", no time means "not today".

const snooze = (text: string) => {
  const parsed = parseNudgeReply(text);
  return parsed?.kind === "snooze" ? parsed.groups : null;
};

const AT_7PM = 19 * 60;

describe("parsing a snooze", () => {
  it("reads several habits sharing one time", () => {
    expect(snooze("1 2 until 15:30")).toEqual([
      { numbers: [1, 2], clockMins: [15 * 60 + 30] },
    ]);
  });

  it("reads the same shape with the commas, the hash marks and the word snooze stripped", () => {
    expect(snooze("please snooze #1, #2 until 15:30")).toEqual([
      { numbers: [1, 2], clockMins: [15 * 60 + 30] },
    ]);
  });

  it("reads two times in one reply", () => {
    expect(snooze("1 until 3:30pm and 2 until 4pm")).toEqual([
      { numbers: [1], clockMins: [15 * 60 + 30] },
      { numbers: [2], clockMins: [16 * 60] },
    ]);
  });

  it("treats a 1-12 hour with no am/pm as both readings", () => {
    expect(snooze("1 until 3:30")).toEqual([
      { numbers: [1], clockMins: [3 * 60 + 30, 15 * 60 + 30] },
    ]);
  });

  it("accepts a dotted am/pm written as its own word", () => {
    expect(snooze("1 until 3:30 p.m.")).toEqual([
      { numbers: [1], clockMins: [15 * 60 + 30] },
    ]);
  });

  it("reads a pause as a snooze when it names a time, since a time is what a delay is", () => {
    expect(snooze("pause 1 until 15:30")).toEqual([
      { numbers: [1], clockMins: [15 * 60 + 30] },
    ]);
  });

  it("rejects a bare ok, a number with no time, and a time with no numbers", () => {
    expect(snooze("ok")).toBeNull();
    expect(snooze("1")).toBeNull();
    expect(snooze("15:30")).toBeNull();
    expect(snooze("1 until 25:00")).toBeNull();
    expect(snooze("1 until 3:60")).toBeNull();
  });
});

// The command for a day the user has decided against on purpose. A snooze can't say that: it
// needs a time they mean to do the thing, so the only honest reply used to be no reply at all.
describe("parsing a pause", () => {
  it("reads the numbers it names", () => {
    expect(parseNudgeReply("pause 1 2")).toEqual({ kind: "pause", numbers: [1, 2] });
    expect(parseNudgeReply("skip 3")).toEqual({ kind: "pause", numbers: [3] });
  });

  it("reads a bare pause as naming nothing, which the caller reads as everything nudging", () => {
    expect(parseNudgeReply("pause")).toEqual({ kind: "pause", numbers: [] });
    expect(parseNudgeReply("Pause it today")).toEqual({ kind: "pause", numbers: [] });
    expect(parseNudgeReply("pause all")).toEqual({ kind: "pause", numbers: [] });
  });

  it("strips the same padding a snooze allows, and dedupes", () => {
    expect(parseNudgeReply("please pause #1, #1 and #2 today")).toEqual({
      kind: "pause",
      numbers: [1, 2],
    });
  });

  it("rejects a pause padded out with anything it can't read", () => {
    // Habits are named by number, never by name - "gym" could be any of several.
    expect(parseNudgeReply("pause gym")).toBeNull();
    expect(parseNudgeReply("pause 0")).toBeNull();
  });
});

describe("soonestUntil", () => {
  it("picks the reading that is still ahead today", () => {
    // 3:30 at 10:00 is 15:30 today, not 03:30 tomorrow.
    expect(soonestUntil([3 * 60 + 30, 15 * 60 + 30], 10 * 60)).toBe(15 * 60 + 30);
  });

  it("sends an explicit afternoon time that has already passed to tomorrow", () => {
    expect(soonestUntil([15 * 60 + 30], AT_7PM)).toBe(MINUTES_TOMORROW + 15 * 60 + 30);
  });

  it("keeps an explicit evening time today", () => {
    expect(soonestUntil([20 * 60 + 30], AT_7PM)).toBe(20 * 60 + 30);
  });

  it("rolls a time that is exactly now forward to tomorrow", () => {
    expect(soonestUntil([AT_7PM], AT_7PM)).toBe(MINUTES_TOMORROW + AT_7PM);
  });
});

const MINUTES_TOMORROW = 24 * 60;

describe("formatting", () => {
  it("prints today as HH:MM and a next-day time with tomorrow", () => {
    expect(formatSnoozeWhen(20 * 60 + 30)).toBe("20:30");
    expect(formatSnoozeWhen(MINUTES_TOMORROW + 15 * 60 + 30)).toBe("15:30 tomorrow");
  });

  it("names each time, the habits on it, and what was left out", () => {
    expect(
      snoozeConfirmation({
        applied: [
          { label: "🥗 Salad", when: "20:30" },
          { label: "🏋️ Gym", when: "20:30" },
        ],
        missedNumbers: [],
        leftOut: false,
      })
    ).toBe("✅ Snoozed until 20:30: 🥗 Salad, 🏋️ Gym.");

    expect(
      snoozeConfirmation({
        applied: [{ label: "🥗 Salad", when: "20:30" }],
        missedNumbers: [9],
        leftOut: true,
      })
    ).toBe(
      "✅ Snoozed until 20:30: 🥗 Salad. No habit numbered 9 is nudging right now. Anything you left out will keep nudging."
    );
  });

  // The reply named 01:00 and the confirmation names 23:00, so the difference has to be
  // accounted for - unexplained, it reads as the app having misheard the time.
  it("accounts for a time it had to pull back", () => {
    expect(
      snoozeConfirmation({
        applied: [{ label: "🥗 Salad", when: "23:00", capped: true }],
        missedNumbers: [],
        leftOut: false,
      })
    ).toBe("✅ Snoozed until 23:00: 🥗 Salad. That's as late as tonight's nudges run.");
  });

  it("says which habits there was no room left to hold", () => {
    expect(
      snoozeConfirmation({
        applied: [],
        tooLate: ["🥗 Salad"],
        missedNumbers: [],
        leftOut: false,
      })
    ).toBe("Too late to snooze 🥗 Salad tonight.");
  });

  it("keeps the hint free of a command when nothing was snoozed", () => {
    expect(snoozeConfirmation({ applied: [], missedNumbers: [], leftOut: false })).toBe(REPLY_HINT);
  });

  // A pause buys silence, so this line is the only place the user would ever learn it took
  // something they didn't mean. It names every habit, and says how long for.
  it("names what a pause reached and how long it lasts", () => {
    expect(
      pauseConfirmation({ paused: ["🥗 Salad"], missedNumbers: [], leftOut: false })
    ).toBe("⏸️ Paused for today: 🥗 Salad. It's back tomorrow.");

    expect(
      pauseConfirmation({ paused: ["🥗 Salad", "🏋️ Gym"], missedNumbers: [], leftOut: false })
    ).toBe("⏸️ Paused for today: 🥗 Salad, 🏋️ Gym. They're back tomorrow.");
  });

  it("answers a pause's unmatched numbers and what it left running in the same voice as a snooze", () => {
    expect(
      pauseConfirmation({ paused: ["🥗 Salad"], missedNumbers: [9], leftOut: true })
    ).toBe(
      "⏸️ Paused for today: 🥗 Salad. It's back tomorrow. No habit numbered 9 is nudging right now. Anything you left out will keep nudging."
    );
  });

  it("falls back to the hint when a pause reached nothing at all", () => {
    expect(pauseConfirmation({ paused: [], missedNumbers: [], leftOut: false })).toBe(REPLY_HINT);
  });
});

// A hold is a delay, so it may not outlive the window in which a dispatch tick still looks at the
// habit's nudge day - past that there is nothing left to resume the ladder, and the snooze would
// be a silent mute that also cancels the partner alert.
describe("snoozeHold", () => {
  const EVENING = "18:00"; // ladder ends at 21:40, so the cap is 23:00
  const LATE = "23:30"; // overhangs midnight, so the cap runs to 02:00

  it("keeps a time the ladder can still reach", () => {
    expect(snoozeHold(20 * 60 + 30, AT_7PM, false, EVENING)).toEqual({
      until: 20 * 60 + 30,
      wall: 20 * 60 + 30,
      capped: false,
    });
  });

  it("pulls back a time past the end of the nudge day", () => {
    // "until 1am" from 19:00 is minute 1500, which no tick on this habit's day ever reaches.
    expect(snoozeHold(MINUTES_TOMORROW + 60, AT_7PM, false, EVENING)).toEqual({
      until: 23 * 60,
      wall: 23 * 60,
      capped: true,
    });
  });

  it("lets a habit whose ladder overhangs midnight hold that late", () => {
    // 01:00, asked for at 23:40 - inside the carryover window, so it stands as asked.
    expect(snoozeHold(MINUTES_TOMORROW + 60, 23 * 60 + 40, false, LATE)).toEqual({
      until: MINUTES_TOMORROW + 60,
      wall: MINUTES_TOMORROW + 60,
      capped: false,
    });
  });

  it("measures a carryover anchor's hold from yesterday's midnight", () => {
    // A reply at 00:20 answering the ladder that started at 23:30 yesterday: 01:00 today is
    // minute 1500 of that nudge day, and the wall time to show the user is still 01:00.
    expect(snoozeHold(60, 20, true, LATE)).toEqual({
      until: MINUTES_TOMORROW + 60,
      wall: 60,
      capped: false,
    });
    // 06:00 is past even an overhanging ladder's reach, so it comes back to 02:00 today.
    expect(snoozeHold(6 * 60, 20, true, LATE)).toEqual({
      until: MINUTES_TOMORROW + 2 * 60,
      wall: 2 * 60,
      capped: true,
    });
  });

  it("holds nothing when the cap has already passed", () => {
    // 23:10, after an 18:00 habit's ladder has run its course: there is no hold to write, and
    // claiming one would be a confirmation saying 23:00 at ten past.
    expect(snoozeHold(MINUTES_TOMORROW + 60, 23 * 60 + 10, false, EVENING)).toBeNull();
  });
});
