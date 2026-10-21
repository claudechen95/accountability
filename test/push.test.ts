import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import { fakeRedis } from "./redis-fake";
import { parsePushSubscription, pwaStartPath, isPushConfigured, MAX_PUSH_SUBSCRIPTIONS } from "@/lib/push";
import {
  getPushSubscriptions,
  savePushSubscription,
  removePushSubscriptions,
} from "@/lib/kv";
import { GET, POST, DELETE } from "@/app/api/push/route";
import { GET as manifest } from "@/app/manifest.webmanifest/route";
import { POST as dispatch } from "@/app/api/nudge/dispatch/route";
import { REPLY_HINT } from "@/lib/snooze";
import type { Goal } from "@/lib/types";
import type { PushSubscriptionRecord } from "@/lib/push";

// The push service is the only thing mocked. Subscription storage, the allowlist, and the
// dispatch route are the real ones, so a reminder that skips the claim or fans out to an
// arbitrary URL fails here rather than in a browser.
const { sendNotification, texts, calls } = vi.hoisted(() => ({
  sendNotification: vi.fn(async (_sub: { endpoint: string }, _body: string, _options?: { topic?: string; urgency?: string }) => ({
    statusCode: 201,
  })),
  texts: [] as { to: string; body: string }[],
  calls: [] as { to: string; script: string }[],
}));

vi.mock("web-push", () => ({
  setVapidDetails: () => {},
  sendNotification,
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
    return "CA1";
  },
  getCallOutcome: async () => "missed" as const,
}));

const apple = (path: string): PushSubscriptionRecord => ({
  endpoint: `https://web.push.apple.com/${path}`,
  expirationTime: null,
  keys: { p256dh: "p256dh-key-material", auth: "auth-key-material" },
});

describe("push subscription shape", () => {
  it("accepts the four push vendors and nothing else", () => {
    const keys = { p256dh: "p256dh-key-material", auth: "auth-key-material" };
    for (const endpoint of [
      "https://web.push.apple.com/Q",
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(parsePushSubscription({ endpoint, keys }), endpoint).not.toBeNull();
    }
    for (const endpoint of [
      "http://web.push.apple.com/Q",
      "https://example.com/push",
      "https://user:pass@web.push.apple.com/Q",
      "https://web.push.apple.com:8443/Q",
      "https://fcm.googleapis.com.evil.example/fcm/send/abc",
    ]) {
      expect(parsePushSubscription({ endpoint, keys }), endpoint).toBeNull();
    }
  });

  it("rejects a subscription with no keys", () => {
    expect(parsePushSubscription({ endpoint: "https://web.push.apple.com/Q" })).toBeNull();
  });
});

describe("installed-app start path", () => {
  it("opens the person whose page was saved to the home screen", () => {
    expect(pwaStartPath("/rochisha/notes")).toBe("/rochisha");
    expect(pwaStartPath("/alan")).toBe("/alan");
    expect(pwaStartPath("/mood")).toBe("/alan");
    expect(pwaStartPath("/")).toBe("/");
    expect(pwaStartPath("/admin")).toBe("/");
    expect(pwaStartPath("https://evil.example/phish")).toBe("/");
    expect(pwaStartPath("//evil.example")).toBe("/");
  });
});

describe("push subscriptions", () => {
  beforeEach(() => {
    fakeRedis.reset();
    fakeRedis.seed("users", [
      { id: "alan", label: "Alan" },
      { id: "rochisha", label: "Rochisha" },
    ]);
  });

  it("keeps one record per device and drops the oldest past the cap", async () => {
    const first = apple("first");
    await savePushSubscription("rochisha", first);
    await savePushSubscription("rochisha", { ...first, keys: { p256dh: "rotated-key-material", auth: "auth-key-material" } });
    expect(await getPushSubscriptions("rochisha")).toEqual([
      { ...first, keys: { p256dh: "rotated-key-material", auth: "auth-key-material" } },
    ]);

    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS; i++) {
      await savePushSubscription("rochisha", apple(`device-${i}`));
    }
    const stored = await getPushSubscriptions("rochisha");
    expect(stored).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    expect(stored.some((sub) => sub.endpoint.endsWith("/first"))).toBe(false);
    expect(stored.at(-1)?.endpoint).toBe("https://web.push.apple.com/device-9");
  });

  it("moves a device to the person who just turned reminders on", async () => {
    const sub = apple("phone");
    await savePushSubscription("rochisha", sub);
    await savePushSubscription(undefined, sub);
    expect(await getPushSubscriptions("rochisha")).toEqual([]);
    expect(await getPushSubscriptions(undefined)).toEqual([sub]);
  });

  it("removes a device that the push service has forgotten", async () => {
    await savePushSubscription("rochisha", apple("keep"));
    await savePushSubscription("rochisha", apple("drop"));
    await removePushSubscriptions("rochisha", ["https://web.push.apple.com/drop"]);
    expect((await getPushSubscriptions("rochisha")).map((sub) => sub.endpoint)).toEqual([
      "https://web.push.apple.com/keep",
    ]);
  });
});

describe("push API", () => {
  beforeEach(() => {
    fakeRedis.reset();
    fakeRedis.seed("users", [
      { id: "alan", label: "Alan" },
      { id: "rochisha", label: "Rochisha" },
    ]);
    process.env.VAPID_PUBLIC_KEY = "public-key";
    process.env.VAPID_PRIVATE_KEY = "private-key";
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
  });

  afterAll(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  it("is off until all three VAPID env vars are set", () => {
    delete process.env.VAPID_SUBJECT;
    expect(isPushConfigured()).toBe(false);
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
    expect(isPushConfigured()).toBe(true);
  });

  it("stores a device and reports it back to that person's home screen", async () => {
    const sub = apple("phone");
    const saved = await POST(jsonRequest("POST", "/api/push?user=rochisha", { subscription: sub }));
    expect(saved.status).toBe(200);

    const listed = await GET(new Request("http://localhost/api/push?user=rochisha"));
    const body = await listed.json();
    expect(body.configured).toBe(true);
    expect(body.publicKey).toBe("public-key");
    expect(body.endpoints).toEqual([sub.endpoint]);
  });

  it("refuses a subscription the server would have to deliver to an arbitrary host", async () => {
    const res = await POST(jsonRequest("POST", "/api/push?user=rochisha", {
      subscription: { endpoint: "https://example.com/hook", keys: apple("x").keys },
    }));
    expect(res.status).toBe(400);
    expect(await getPushSubscriptions("rochisha")).toEqual([]);
  });

  it("forgets a device when reminders are turned off", async () => {
    const sub = apple("phone");
    await savePushSubscription("rochisha", sub);
    const res = await DELETE(jsonRequest("DELETE", "/api/push?user=rochisha", { endpoint: sub.endpoint }));
    expect(res.status).toBe(200);
    expect(await getPushSubscriptions("rochisha")).toEqual([]);
  });
});

describe("web app manifest", () => {
  it("installs as an app that opens the person who saved it", async () => {
    const res = await manifest(new Request("http://localhost/manifest.webmanifest?start=/rochisha/history"));
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const body = await res.json();
    expect(body.display).toBe("standalone");
    expect(body.start_url).toBe("/rochisha");
    expect(body.scope).toBe("/");
    expect(body.icons.some((icon: { sizes: string }) => icon.sizes === "192x192")).toBe(true);
    expect(body.icons.some((icon: { sizes: string }) => icon.sizes === "512x512")).toBe(true);
  });

  it("ignores a start path that is not one of ours", async () => {
    const res = await manifest(new Request("http://localhost/manifest.webmanifest?start=https://evil.example/phish"));
    expect((await res.json()).start_url).toBe("/");
  });
});

describe("installed app files", () => {
  it("ships a service worker and the icons a home screen needs", () => {
    for (const file of ["public/sw.js", "public/icon-192.png", "public/icon-512.png", "public/apple-touch-icon.png"]) {
      expect(existsSync(file), file).toBe(true);
    }
    const worker = readFileSync("public/sw.js", "utf8");
    expect(worker).toContain("push");
    expect(worker).toContain("notificationclick");
  });
});

const TODAY = "2026-08-26";
const SECRET = "test-dispatch-secret";
const PHONE = "+15550000001";

const salad: Goal = {
  id: "salad",
  name: "Salad",
  emoji: "🥗",
  frequency: "daily",
  targetCount: 1,
  nudgeTime: "18:00",
};

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

async function tickAt(hhmm: string) {
  const min = toMin(hhmm);
  vi.setSystemTime(new Date(Date.UTC(2026, 7, 26, 7 + Math.floor(min / 60), min % 60)));
  return dispatch(new Request("http://localhost/api/nudge/dispatch", {
    method: "POST",
    headers: { "x-nudge-secret": SECRET },
  }));
}

function pushBodies(): { title: string; body: string; url: string }[] {
  return sendNotification.mock.calls.map((call) => JSON.parse(call[1]));
}

describe("reminders delivered as a notification", () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    delete process.env.NUDGE_DISPATCH_SECRET;
  });

  beforeEach(() => {
    fakeRedis.reset();
    texts.length = 0;
    calls.length = 0;
    sendNotification.mockReset();
    sendNotification.mockResolvedValue({ statusCode: 201 });
    process.env.NUDGE_DISPATCH_SECRET = SECRET;
    process.env.VAPID_PUBLIC_KEY = "public-key";
    process.env.VAPID_PRIVATE_KEY = "private-key";
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
    fakeRedis.seed("users", [{ id: "tester", label: "Tester", phone: PHONE }]);
    fakeRedis.seed("tester:goals", [salad]);
    fakeRedis.seed("tester:push:subscriptions", [apple("phone")]);
  });

  it("sends the habit list once per text slot, without the text-reply instructions", async () => {
    await tickAt("18:00");
    await tickAt("18:10");
    expect(texts.map((text) => text.body)).toEqual([expect.stringContaining(REPLY_HINT)]);
    expect(pushBodies()).toEqual([{ title: "Still pending", body: "1. 🥗 Salad", url: "/tester" }]);
    const options = sendNotification.mock.calls[0][2];
    expect(options?.topic).toBe("nudge");
    expect(options?.urgency).toBe("high");
  });

  it("still notifies a person who has no phone number, and does not call them", async () => {
    fakeRedis.seed("users", [{ id: "tester", label: "Tester" }]);
    for (const at of ["18:00", "19:20", "20:40", "20:50"]) await tickAt(at);
    expect(pushBodies().map((push) => push.body)).toEqual(["1. 🥗 Salad", "1. 🥗 Salad", "1. 🥗 Salad"]);
    expect(texts).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("stays quiet while a habit is snoozed", async () => {
    fakeRedis.seed(`tester:nudge:snoozed-until:salad:${TODAY}`, 20 * 60);
    await tickAt("18:00");
    expect(sendNotification).not.toHaveBeenCalled();
    expect(texts).toEqual([]);
  });

  it("drops a subscription the push service reports as gone and keeps the rest", async () => {
    const gone = apple("gone");
    const stay = {
      endpoint: "https://fcm.googleapis.com/fcm/send/stay",
      expirationTime: null,
      keys: { p256dh: "p256dh-key-material", auth: "auth-key-material" },
    };
    fakeRedis.seed("tester:push:subscriptions", [gone, stay]);
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === gone.endpoint) {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
      return { statusCode: 201 };
    });
    const res = await tickAt("18:00");
    expect(res.status).toBe(200);
    expect(await getPushSubscriptions("tester")).toEqual([stay]);
  });

  it("leaves the subscription in place when a send fails for any other reason", async () => {
    sendNotification.mockRejectedValue(new Error("network"));
    const res = await tickAt("18:00");
    expect(res.status).toBe(200);
    expect(await getPushSubscriptions("tester")).toEqual([apple("phone")]);
    expect(texts).toHaveLength(1);
  });
});
