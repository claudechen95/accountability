import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import { fakeRedis } from "./redis-fake";
import { checkinPushTag } from "@/lib/push";
import { getPushSubscriptions } from "@/lib/kv";
import { POST } from "@/app/api/checkins/route";
import type { Goal } from "@/lib/types";
import type { PushSubscriptionRecord } from "@/lib/push";

// The push service and ntfy are the only things mocked. The check-in route, partner lookup,
// and subscription storage are real, so a completion that lands on the wrong person fails here.
const { sendNotification } = vi.hoisted(() => ({
  sendNotification: vi.fn(async (
    _sub: { endpoint: string },
    _body: string,
    _options?: { topic?: string; urgency?: string; TTL?: number },
  ) => ({ statusCode: 201 })),
}));

vi.mock("web-push", () => ({
  setVapidDetails: () => {},
  sendNotification,
}));

const ALAN = "+15550000001";
const CLAUDE = "+15550000002";

const salad: Goal = {
  id: "salad",
  name: "Salad",
  emoji: "🥗",
  frequency: "daily",
  targetCount: 1,
};

const apple = (path: string): PushSubscriptionRecord => ({
  endpoint: `https://web.push.apple.com/${path}`,
  expirationTime: null,
  keys: { p256dh: "p256dh-key-material", auth: "auth-key-material" },
});

const fetchMock = vi.fn(async (_url: string, _init?: { method?: string; body?: string }) =>
  new Response("ok", { status: 200 }),
);

function checkIn(user: string, body: Record<string, unknown> = { goalId: "salad" }) {
  return POST(new Request(`http://localhost/api/checkins?user=${user}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function pushes() {
  return sendNotification.mock.calls.map((call) => ({
    endpoint: call[0].endpoint,
    payload: JSON.parse(call[1]) as {
      title: string;
      body: string;
      url: string;
      tag?: string;
      renotify?: boolean;
    },
    options: call[2],
  }));
}

function ntfyCalls() {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("ntfy.sh"));
}

describe("check-in push tag", () => {
  it("stays within Apple's 32-character topic limit and never collides with a reminder", () => {
    const tag = checkinPushTag("7d80dcda-ae6f-4f97-a1bb-ecc9b7d741ff");
    expect(tag.length).toBeLessThanOrEqual(32);
    expect(tag).toMatch(/^[A-Za-z0-9]+$/);
    expect(tag).not.toBe("nudge");
    expect(checkinPushTag("salad")).not.toBe(checkinPushTag("gym"));
  });
});

describe("a check-in notifies the partner", () => {
  beforeEach(() => {
    fakeRedis.reset();
    sendNotification.mockReset();
    sendNotification.mockResolvedValue({ statusCode: 201 });
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.VAPID_PUBLIC_KEY = "public-key";
    process.env.VAPID_PRIVATE_KEY = "private-key";
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
    delete process.env.NTFY_TOPIC;
    fakeRedis.seed("users", [
      { id: "alan", label: "Alan", phone: ALAN, partnerPhone: CLAUDE, checkinTopic: "alan-checkins" },
      { id: "claude", label: "Claude", phone: CLAUDE, partnerPhone: ALAN, checkinTopic: "claude-checkins" },
    ]);
    fakeRedis.seed("claude:goals", [salad]);
    fakeRedis.seed("goals", [salad]);
    fakeRedis.seed("push:subscriptions", [apple("alan-phone")]);
    fakeRedis.seed("claude:push:subscriptions", [apple("claude-phone")]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  it("sends it to the partner's devices, not the person who checked in", async () => {
    const res = await checkIn("claude");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 1 });

    expect(pushes()).toEqual([
      {
        endpoint: "https://web.push.apple.com/alan-phone",
        payload: {
          title: "Claude checked in",
          body: "🥗 Salad",
          url: "/claude",
          tag: checkinPushTag("salad"),
          renotify: true,
        },
        options: {
          topic: checkinPushTag("salad"),
          urgency: "high",
          TTL: 12 * 60 * 60,
        },
      },
    ]);
    expect(ntfyCalls()).toEqual([]);
  });

  it("notifies Claude when Alan checks in, and opens Alan's tracker", async () => {
    const res = await checkIn("alan");
    expect(res.status).toBe(200);
    expect(pushes().map((push) => push.endpoint)).toEqual(["https://web.push.apple.com/claude-phone"]);
    expect(pushes()[0]?.payload).toMatchObject({ title: "Alan checked in", url: "/alan" });
    expect(ntfyCalls()).toEqual([]);
  });

  it("notifies every device the partner has turned on", async () => {
    fakeRedis.seed("push:subscriptions", [apple("alan-phone"), apple("alan-ipad")]);
    await checkIn("claude");
    expect(pushes().map((push) => push.endpoint).sort()).toEqual([
      "https://web.push.apple.com/alan-ipad",
      "https://web.push.apple.com/alan-phone",
    ]);
  });

  it("matches a partner number that was typed with formatting", async () => {
    fakeRedis.seed("users", [
      { id: "alan", label: "Alan", phone: ALAN },
      { id: "claude", label: "Claude", phone: CLAUDE, partnerPhone: "(555) 000-0001", checkinTopic: "claude-checkins" },
    ]);
    await checkIn("claude");
    expect(pushes().map((push) => push.endpoint)).toEqual(["https://web.push.apple.com/alan-phone"]);
  });

  it("does not notify anyone for a history backfill", async () => {
    const res = await checkIn("claude", { goalId: "salad", date: "2026-08-01" });
    expect(res.status).toBe(200);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(ntfyCalls()).toEqual([]);
  });

  it("falls back to the check-in topic when the partner has no installed app", async () => {
    fakeRedis.seed("push:subscriptions", []);
    const res = await checkIn("claude");
    expect(res.status).toBe(200);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(ntfyCalls()).toHaveLength(1);
    expect(String(ntfyCalls()[0][0])).toBe("https://ntfy.sh/claude-checkins");
    expect(ntfyCalls()[0][1]).toMatchObject({
      method: "POST",
      body: "🥗 Salad (daily)",
    });
  });

  it("falls back to ntfy when push is not configured", async () => {
    delete process.env.VAPID_SUBJECT;
    await checkIn("claude");
    expect(sendNotification).not.toHaveBeenCalled();
    expect(ntfyCalls()).toHaveLength(1);
  });

  it("falls back to ntfy when the partner number matches nobody", async () => {
    fakeRedis.seed("users", [
      { id: "claude", label: "Claude", phone: CLAUDE, partnerPhone: "+15559999999", checkinTopic: "claude-checkins" },
    ]);
    await checkIn("claude");
    expect(sendNotification).not.toHaveBeenCalled();
    expect(ntfyCalls()).toHaveLength(1);
  });

  it("still checks in when the push service errors, and then tries ntfy", async () => {
    sendNotification.mockRejectedValue(new Error("network"));
    const res = await checkIn("claude");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 1 });
    expect(ntfyCalls()).toHaveLength(1);
    expect(await getPushSubscriptions(undefined)).toEqual([apple("alan-phone")]);
  });

  it("drops a subscription the push service has forgotten and does not also ntfy if another device got it", async () => {
    const gone = apple("gone");
    const stay = apple("alan-phone");
    fakeRedis.seed("push:subscriptions", [gone, stay]);
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === gone.endpoint) {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
      return { statusCode: 201 };
    });
    const res = await checkIn("claude");
    expect(res.status).toBe(200);
    expect(await getPushSubscriptions(undefined)).toEqual([stay]);
    expect(ntfyCalls()).toEqual([]);
  });

  it("uses ntfy when every partner device is gone", async () => {
    sendNotification.mockImplementation(async () => {
      const err = new Error("gone") as Error & { statusCode: number };
      err.statusCode = 410;
      throw err;
    });
    await checkIn("claude");
    expect(await getPushSubscriptions(undefined)).toEqual([]);
    expect(ntfyCalls()).toHaveLength(1);
  });

  it("does not push to yourself when the partner number is your own", async () => {
    fakeRedis.seed("users", [
      { id: "claude", label: "Claude", phone: CLAUDE, partnerPhone: CLAUDE, checkinTopic: "claude-checkins" },
    ]);
    await checkIn("claude");
    expect(sendNotification).not.toHaveBeenCalled();
    expect(ntfyCalls()).toHaveLength(1);
  });

  it("does not notify for a habit that has graduated", async () => {
    fakeRedis.seed("claude:goals", [{ ...salad, graduatedAt: "2026-08-01" }]);
    const res = await checkIn("claude");
    expect(res.status).toBe(409);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(ntfyCalls()).toEqual([]);
  });
});

describe("installed app notification tag", () => {
  it("uses the payload tag so a check-in does not replace a reminder", () => {
    const worker = readFileSync("public/sw.js", "utf8");
    expect(worker).toContain("payload.tag");
    expect(worker).not.toMatch(/tag:\s*"nudge"/);
  });
});
