import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { fakeRedis } from "./redis-fake";
import { POST } from "@/app/api/nudge/inbound/route";
import { isNudgeMuted, getNudgeSnoozedUntil } from "@/lib/kv";
import { SNOOZE_HINT } from "@/lib/snooze";
import type { Goal } from "@/lib/types";

// Sendblue's inbound webhook. A reply snoozes the numbered habits that are nudging, until the
// clock time it names. Anything else, including the old "pause", leaves the ladder running.

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

describe("pause no longer mutes anything", () => {
  it("leaves every habit running when the reply is pause", async () => {
    await reply("pause");
    expect(await muted("salad")).toBe(false);
    expect(await muted("gym")).toBe(false);
    expect(await muted("journal")).toBe(false);
    expect(await getNudgeSnoozedUntil("tester", "salad", TODAY)).toBeNull();
    expect(texts[0].body).toBe(SNOOZE_HINT);
  });

  it("does the same for a reply that names nothing", async () => {
    await reply("ok");
    expect(await muted("salad")).toBe(false);
    expect(await getNudgeSnoozedUntil("tester", "gym", TODAY)).toBeNull();
    expect(texts[0].body).toBe(SNOOZE_HINT);
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

  it("sends the instructions when the reply arrives with nothing nudging", async () => {
    fakeRedis.seed("tester:goals", [goals[2]]); // only the 21:00 habit, and it's 19:00
    await reply("on it");
    expect(texts[0].body).toBe(`Nothing's nudging you right now. ${SNOOZE_HINT}`);
  });
});
