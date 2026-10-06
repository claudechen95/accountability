import { describe, it, expect } from "vitest";
import {
  SNOOZE_HINT,
  formatSnoozeWhen,
  parseSnoozeReply,
  snoozeConfirmation,
  snoozeUntilOnAnchor,
  soonestUntil,
} from "@/lib/snooze";

// The reply grammar. A nudge text tells the user to answer with habit numbers and a clock time,
// and this is the whole of what counts as that answer. Anything else, including the old "pause",
// is not a snooze.

const AT_7PM = 19 * 60;

describe("parseSnoozeReply", () => {
  it("reads several habits sharing one time", () => {
    expect(parseSnoozeReply("1 2 until 15:30")).toEqual([
      { numbers: [1, 2], clockMins: [15 * 60 + 30] },
    ]);
  });

  it("reads the same shape with the commas, the hash marks and the word snooze stripped", () => {
    expect(parseSnoozeReply("please snooze #1, #2 until 15:30")).toEqual([
      { numbers: [1, 2], clockMins: [15 * 60 + 30] },
    ]);
  });

  it("reads two times in one reply", () => {
    expect(parseSnoozeReply("1 until 3:30pm and 2 until 4pm")).toEqual([
      { numbers: [1], clockMins: [15 * 60 + 30] },
      { numbers: [2], clockMins: [16 * 60] },
    ]);
  });

  it("treats a 1-12 hour with no am/pm as both readings", () => {
    expect(parseSnoozeReply("1 until 3:30")).toEqual([
      { numbers: [1], clockMins: [3 * 60 + 30, 15 * 60 + 30] },
    ]);
  });

  it("accepts a dotted am/pm written as its own word", () => {
    expect(parseSnoozeReply("1 until 3:30 p.m.")).toEqual([
      { numbers: [1], clockMins: [15 * 60 + 30] },
    ]);
  });

  it("rejects pause, a bare ok, a number with no time, and a time with no numbers", () => {
    expect(parseSnoozeReply("pause")).toBeNull();
    expect(parseSnoozeReply("ok")).toBeNull();
    expect(parseSnoozeReply("1")).toBeNull();
    expect(parseSnoozeReply("15:30")).toBeNull();
    expect(parseSnoozeReply("1 until 25:00")).toBeNull();
    expect(parseSnoozeReply("1 until 3:60")).toBeNull();
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

  it("shifts a wall-clock time onto yesterday's minute count for a carryover anchor", () => {
    expect(snoozeUntilOnAnchor(60, true)).toBe(MINUTES_TOMORROW + 60);
    expect(snoozeUntilOnAnchor(20 * 60 + 30, false)).toBe(20 * 60 + 30);
  });

  it("names each time, the habits on it, and what was left out", () => {
    expect(
      snoozeConfirmation(
        [
          { label: "🥗 Salad", when: "20:30" },
          { label: "🏋️ Gym", when: "20:30" },
        ],
        [],
        false
      )
    ).toBe("✅ Snoozed until 20:30: 🥗 Salad, 🏋️ Gym.");

    expect(
      snoozeConfirmation([{ label: "🥗 Salad", when: "20:30" }], [9], true)
    ).toBe(
      "✅ Snoozed until 20:30: 🥗 Salad. No habit numbered 9 is nudging right now. Anything you left out will keep nudging."
    );
  });

  it("keeps the hint free of a command when nothing was snoozed", () => {
    expect(snoozeConfirmation([], [], false)).toBe(SNOOZE_HINT);
  });
});
