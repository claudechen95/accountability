import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { fakeRedis } from "./redis-fake";
import { POST } from "@/app/api/nudge/inbound/route";
import { isNudgeMuted } from "@/lib/kv";
import type { Goal } from "@/lib/types";

// Sendblue's inbound webhook. The behaviour that matters here is the authorization gate and the
// scope of a reply: *any* reply mutes the habits that were nudging at the time, and only those.

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

describe("a reply mutes what was nudging, and only that", () => {
  // The bar is deliberately low: the escalation's job is to reach a person, and any answer at
  // all proves it did. What the answer *says* doesn't narrow or widen the effect.
  it("counts a reply that names nothing at all", async () => {
    await reply("ok");
    expect(await muted("salad")).toBe(true);
    expect(await muted("gym")).toBe(true);
  });

  // The regression this scoping exists for. A reply at 19:00 cannot be an answer about a habit
  // that doesn't start nudging until 21:00 - that habit hasn't asked anything yet.
  it("leaves a habit alone when its nudge time hasn't come round yet", async () => {
    await reply("pause");
    expect(await muted("journal")).toBe(false);
  });

  it("mutes every habit that was nudging, not just the one the reply named", async () => {
    await reply("gym");
    expect(await muted("gym")).toBe(true);
    expect(await muted("salad")).toBe(true);
    expect(await muted("journal")).toBe(false);
  });

  it("ignores an empty message, which is not an answer to anything", async () => {
    await reply("   ");
    expect(await muted("salad")).toBe(false);
    expect(texts).toHaveLength(0);
  });

  it("does nothing for a number belonging to no user", async () => {
    await reply("ok", { number: "+15559999999" });
    expect(await muted("salad")).toBe(false);
  });
});

describe("the confirmation text", () => {
  // It has to name what it muted *and* say that later habits are still coming - "muted for
  // today", unqualified, is exactly the over-promise that made a noon "pause" feel like it had
  // swallowed the evening.
  it("names what it muted and promises the rest of the day will still nudge", async () => {
    await reply("pause");
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toBe(
      "✅ Got it: 🥗 Salad, 🏋️ Gym. Muted for the rest of today. Any habit due later today will still nudge you."
    );
  });

  it("says so plainly when the reply arrived with nothing nudging", async () => {
    fakeRedis.seed("tester:goals", [goals[2]]); // only the 21:00 habit, and it's 19:00
    await reply("on it");
    expect(texts[0].body).toBe("✅ Got it. Nothing's nudging you right now.");
  });
});
