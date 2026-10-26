import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { fakeRedis } from "./redis-fake";
import { POST } from "@/app/api/nudge/inbound/route";
import { isNudgeMuted, getNudgeSnoozedUntil, getCheckInsForPeriod } from "@/lib/kv";
import { checkinPushTag } from "@/lib/push";
import { REPLY_HINT } from "@/lib/snooze";
import type { Goal } from "@/lib/types";

const { sendNotification } = vi.hoisted(() => ({
  sendNotification: vi.fn(async (
    _sub: { endpoint: string },
    _body: string,
    _options?: { topic?: string; TTL?: number },
  ) => ({ statusCode: 201 })),
}));

vi.mock("web-push", () => ({
  setVapidDetails: () => {},
  sendNotification,
}));

// Sendblue's inbound webhook. A reply checks in the numbered habits ("done 1"), snoozes the
// numbered habits that are nudging until the clock time it names, or pauses them for the day.
// Anything else leaves the ladder running.

const { texts } = vi.hoisted(() => ({ texts: [] as { to: string; body: string }[] }));

vi.mock("@/lib/sendblue", () => ({
  sendText: async (to: string, content: string) => {
    texts.push({ to, body: content });
  },
}));

const TODAY = "2026-08-26"; // Wednesday, PDT
const SECRET = "test-webhook-secret";
const PHONE = "+15550000001";

const goals: Goal[] = [
  { id: "salad", name: "Salad", emoji: "🥗", frequency: "daily", targetCount: 1, nudgeTime: "18:00", nudgeNumber: 1 },
  { id: "gym", name: "Gym", emoji: "🏋️", frequency: "daily", targetCount: 1, nudgeTime: "18:00", nudgeNumber: 2 },
  // Nudges at 21:00, two hours after the reply below arrives - so it has asked the user nothing
  // yet, and a reply cannot be an answer to it.
  { id: "journal", name: "Video Journal", emoji: "📝", frequency: "daily", targetCount: 1, nudgeTime: "21:00", nudgeNumber: 3 },
];

async function reply(content: string, opts: { secret?: string | null; number?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) headers["sb-webhook-secret"] = secret;
  return POST(
    new Request("http://localhost/api/nudge/inbound", {
      method: "POST",
      headers,
      body: JSON.stringify({ is_outbound: false, number: opts.number ?? PHONE, content }),
    })
  );
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 2, 0))); // 19:00 PDT, mid-ladder
  process.env.SENDBLUE_WEBHOOK_SECRET = SECRET;
});

afterAll(() => vi.useRealTimers());

beforeEach(() => {
  fakeRedis.reset();
  texts.length = 0;
  fakeRedis.seed("users", [{ id: "tester", label: "Tester", phone: PHONE }]);
  fakeRedis.seed("tester:goals", goals);
});

async function muted(goalId: string) {
  return isNudgeMuted("tester", goalId, TODAY);
}

describe("authorization", () => {
  it("rejects a reply with no secret, and records nothing", async () => {
    const res = await reply("pause", { secret: null });
    expect(res.status).toBe(401);
    expect(await muted("salad")).toBe(false);
  });

  it("rejects a reply with the wrong secret", async () => {
    expect((await reply("pause", { secret: "nope" })).status).toBe(401);
    expect(await muted("salad")).toBe(false);
  });
});

// The case a snooze can't express: the user has decided against the habit today, so there is no
// later time to name. A pause is the same full exit as answering the phone - no more texts, no
// call, and no partner alert - and it is a delay in no sense, so it writes no hold.
describe("pausing for the day", () => {
  it("mutes every habit that is nudging when the reply names no numbers", async () => {
    await reply("pause");
    expect(await muted("salad")).toBe(true);
    expect(await muted("gym")).toBe(true);
    // Journal nudges at 21:00, two hours out. A bare pause is still only an answer to the
    // question that was asked, which is the scoping the Sep 2026 bug was about.
    expect(await muted("journal")).toBe(false);
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBeNull();
    expect(texts[0].body).toBe("⏸️ Paused for today: 🥗 Salad, 🏋️ Gym. They're back tomorrow.");
  });

  it("mutes only the habit a numbered pause names, and says so", async () => {
    await reply("pause 1");
    expect(await muted("salad")).toBe(true);
    expect(await muted("gym")).toBe(false);
    expect(texts[0].body).toBe(
      "⏸️ Paused for today: 🥗 Salad. It's back tomorrow. Anything you left out will keep nudging."
    );
  });

  it("mutes nothing when the number belongs to a habit that hasn't nudged yet", async () => {
    await reply("pause 3");
    expect(await muted("journal")).toBe(false);
    expect(await muted("salad")).toBe(false);
    expect(texts[0].body).toBe(
      "No habit numbered 3 is nudging right now. Anything you left out will keep nudging."
    );
  });

  it("mutes nothing when a pause arrives with nothing nudging", async () => {
    fakeRedis.seed("tester:goals", [goals[2]]); // only the 21:00 habit, and it's 19:00
    await reply("pause");
    expect(await muted("journal")).toBe(false);
    expect(texts[0].body).toBe(`Nothing's nudging you right now. ${REPLY_HINT}`);
  });

  it("reads a pause that names a time as the snooze it is", async () => {
    await reply("pause 1 until 20:30");
    expect(await muted("salad")).toBe(false);
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBe(20 * 60 + 30);
  });
});

describe("a reply that is neither command", () => {
  it("leaves every habit running and sends the instructions", async () => {
    await reply("ok");
    expect(await muted("salad")).toBe(false);
    expect(await getNudgeSnoozedUntil("tester", "gym", TODAY)).toBeNull();
    expect(texts[0].body).toBe(REPLY_HINT);
  });

  it("ignores an empty message, which is not an answer to anything", async () => {
    await reply("   ");
    expect(await muted("salad")).toBe(false);
    expect(texts).toHaveLength(0);
  });

  it("does nothing for a number belonging to no user", async () => {
    await reply("1 until 20:30", { number: "+15559999999" });
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBeNull();
    expect(texts).toHaveLength(0);
  });
});

describe("snoozing the habits a reply names", () => {
  it("snoozes several habits until one time, and leaves a later habit alone", async () => {
    await reply("1 2 until 20:30");
    // 20:30 is 1230 minutes from midnight, and it's still ahead at 19:00.
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBe(20 * 60 + 30);
    expect(await getNudgeSnoozedUntil("tester", "gym", TODAY)).toBe(20 * 60 + 30);
    // Journal nudges at 21:00, so it isn't part of this reply even though 2 would have been
    // next to it in the list. It wasn't asked yet, and it wasn't named.
    expect(await getNudgeSnoozedUntil("tester", "journal", TODAY)).toBeNull();
    expect(await muted("salad")).toBe(false);
    expect(texts[0].body).toBe("✅ Snoozed until 20:30: 🥗 Salad, 🏋️ Gym.");
  });

  it("gives two habits two different times in one reply", async () => {
    await reply("1 until 8:30pm and 2 until 21:00");
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBe(20 * 60 + 30);
    expect(await getNudgeSnoozedUntil("tester", "gym", TODAY)).toBe(21 * 60);
    expect(texts[0].body).toBe(
      "✅ Snoozed until 20:30: 🥗 Salad. Snoozed until 21:00: 🏋️ Gym."
    );
  });

  it("says what it left nudging when the reply only named one of them", async () => {
    await reply("1 until 20:30");
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBe(20 * 60 + 30);
    expect(await getNudgeSnoozedUntil("tester", "gym", TODAY)).toBeNull();
    expect(texts[0].body).toBe(
      "✅ Snoozed until 20:30: 🥗 Salad. Anything you left out will keep nudging."
    );
  });

  // The regression the scoping exists for. Naming the 21:00 habit at 19:00 cannot hold it:
  // it hasn't asked anything yet.
  it("does not snooze a habit whose nudge time hasn't come round yet", async () => {
    await reply("3 until 21:30");
    expect(await getNudgeSnoozedUntil("tester", "journal", TODAY)).toBeNull();
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBeNull();
    expect(texts[0].body).toBe(
      "No habit numbered 3 is nudging right now. Anything you left out will keep nudging."
    );
  });

  it("writes an after-midnight hold under the nudge day the ladder belongs to", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 7, 20))); // 00:20 PDT on Aug 27
    try {
      fakeRedis.seed("tester:goals", [
        { ...goals[2], nudgeTime: "23:30", nudgeNumber: 1 },
      ]);
      await reply("1 until 1:00");
      // 01:00 today is minute 1500 from midnight of Aug 26, the day the 23:30 ladder started.
      expect(await getNudgeSnoozedUntil("tester", "journal", TODAY)).toBe(24 * 60 + 60);
      expect(texts[0].body).toBe("✅ Snoozed until 01:00: 📝 Video Journal.");
    } finally {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 2, 0))); // back to 19:00 PDT Aug 26
    }
  });

  // A hold has to stay inside the window the dispatch tick still looks at the nudge day in, or
  // it cancels the calls and the partner alert instead of delaying them. The reply is honoured as
  // far as it can be, and the confirmation names the time that was actually written - the gap
  // between what was asked and what was stored is the whole reason it says why.
  it("pulls a hold back to the latest minute the ladder can still finish in", async () => {
    await reply("1 until 1am");
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBe(23 * 60);
    expect(texts[0].body).toBe(
      "✅ Snoozed until 23:00: 🥗 Salad. That's as late as tonight's nudges run. Anything you left out will keep nudging."
    );
  });

  it("writes no hold at all once there's no room left for one", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 6, 10))); // 23:10 PDT, past Salad's cap
    try {
      await reply("1 until 1am");
      expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBeNull();
      expect(texts[0].body).toBe(
        "Too late to snooze 🥗 Salad tonight. Anything you left out will keep nudging."
      );
    } finally {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 2, 0))); // back to 19:00 PDT Aug 26
    }
  });

  it("sends the instructions when the reply arrives with nothing nudging", async () => {
    fakeRedis.seed("tester:goals", [goals[2]]); // only the 21:00 habit, and it's 19:00
    await reply("on it");
    expect(texts[0].body).toBe(`Nothing's nudging you right now. ${REPLY_HINT}`);
  });
});

// "done 1" is a check-in, not a mute. The habit has to show as done, and the ladder stops
// because it is done - a pause would silence the same evening while leaving the day missed.
describe("checking a habit in", () => {
  async function count(goalId: string, date = TODAY) {
    return getCheckInsForPeriod(goalId, date, "tester");
  }

  it("checks in only the habit the number names", async () => {
    await reply("done 1");
    expect(await count("salad")).toBe(1);
    expect(await count("gym")).toBe(0);
    expect(await muted("salad")).toBe(false);
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBeNull();
    expect(texts[0].body).toBe(
      "✅ Checked off: 🥗 Salad. Anything you left out will keep nudging."
    );
  });

  it("checks in several habits named in one reply", async () => {
    await reply("done #1 and #2");
    expect(await count("salad")).toBe(1);
    expect(await count("gym")).toBe(1);
    expect(await count("journal")).toBe(0);
    expect(texts[0].body).toBe("✅ Checked off: 🥗 Salad, 🏋️ Gym.");
  });

  it("fills a daily habit up to its target, so done means done", async () => {
    fakeRedis.seed("tester:goals", [{ ...goals[0], targetCount: 3 }]);
    fakeRedis.seed(`tester:checkin:salad:${TODAY}`, 1);
    await reply("done 1");
    expect(await count("salad")).toBe(3);
  });

  it("logs a weekly habit once for the day, rather than filling the week's target", async () => {
    fakeRedis.seed("tester:goals", [
      {
        ...goals[0],
        frequency: "weekly" as const,
        targetCount: 3,
        nudgeDays: [3], // Wednesday, which is today
      },
    ]);
    await reply("done 1");
    expect(await count("salad")).toBe(1);
  });

  it("checks in nothing when the number belongs to a habit that hasn't nudged yet", async () => {
    await reply("done 3");
    expect(await count("journal")).toBe(0);
    expect(await count("salad")).toBe(0);
    expect(texts[0].body).toBe(
      "No habit numbered 3 is nudging right now. Anything you left out will keep nudging."
    );
  });

  it("checks nothing in and resends the instructions when the reply is a bare done", async () => {
    await reply("done");
    expect(await count("salad")).toBe(0);
    expect(await count("gym")).toBe(0);
    expect(texts[0].body).toBe(REPLY_HINT);
  });

  it("reads a done that names a time as the snooze it is", async () => {
    await reply("done 1 until 20:30");
    expect(await count("salad")).toBe(0);
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBe(20 * 60 + 30);
  });

  it("writes the check-in on the nudge day when the reply arrives after midnight", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 7, 20))); // 00:20 PDT on Aug 27
    try {
      fakeRedis.seed("tester:goals", [
        { ...goals[2], nudgeTime: "23:30", nudgeNumber: 1 },
      ]);
      await reply("done 1");
      // The ladder started on Aug 26. Checking in Aug 27 would leave that evening unfinished.
      expect(await count("journal", TODAY)).toBe(1);
      expect(await count("journal", "2026-08-27")).toBe(0);
      expect(texts[0].body).toBe("✅ Checked off: 📝 Video Journal.");
    } finally {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 27, 2, 0))); // back to 19:00 PDT Aug 26
    }
  });

  it("sends the instructions when a done arrives with nothing nudging", async () => {
    fakeRedis.seed("tester:goals", [goals[2]]);
    await reply("done 3");
    expect(await count("journal")).toBe(0);
    expect(texts[0].body).toBe(`Nothing's nudging you right now. ${REPLY_HINT}`);
  });

  it("tells the partner once, on the check-in tag, even when the habit took several counts", async () => {
    const previous = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: process.env.VAPID_SUBJECT,
    };
    process.env.VAPID_PUBLIC_KEY = "public-key";
    process.env.VAPID_PRIVATE_KEY = "private-key";
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
    sendNotification.mockClear();
    try {
      const partner = "+15550000002";
      fakeRedis.seed("users", [
        { id: "tester", label: "Tester", phone: PHONE, partnerPhone: partner },
        { id: "claude", label: "Claude", phone: partner, partnerPhone: PHONE },
      ]);
      fakeRedis.seed("tester:goals", [{ ...goals[0], targetCount: 3 }]);
      fakeRedis.seed("claude:push:subscriptions", [{
        endpoint: "https://web.push.apple.com/claude-phone",
        expirationTime: null,
        keys: { p256dh: "p256dh-key-material", auth: "auth-key-material" },
      }]);
      await reply("done 1");
      expect(await count("salad")).toBe(3);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      const [sub, body, options] = sendNotification.mock.calls[0];
      expect(sub.endpoint).toBe("https://web.push.apple.com/claude-phone");
      expect(JSON.parse(body)).toMatchObject({
        title: "Tester checked in",
        body: "🥗 Salad",
        url: "/tester",
        tag: checkinPushTag("salad"),
      });
      expect(options).toMatchObject({ topic: checkinPushTag("salad"), TTL: 12 * 60 * 60 });
    } finally {
      for (const [key, value] of Object.entries({
        VAPID_PUBLIC_KEY: previous.publicKey,
        VAPID_PRIVATE_KEY: previous.privateKey,
        VAPID_SUBJECT: previous.subject,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
