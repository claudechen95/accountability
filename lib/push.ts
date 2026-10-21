// Web Push subscriptions and the VAPID config that signs them.
//
// This file stays free of the `web-push` package so the home screen can ask "are reminders
// configured?" without pulling the crypto library into a browser bundle. Sending lives in
// lib/web-push.ts.

import { pwaStartPath } from "./pwa";

export { pwaStartPath };

// One person, a handful of devices. Past this the oldest registration is dropped: a phone that
// still has the app will show the button again and register once more.
export const MAX_PUSH_SUBSCRIPTIONS = 10;

export interface PushSubscriptionRecord {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

// The tick POSTs to whatever endpoint we stored. A subscription is a URL the browser's push
// vendor gave us, so anything else would turn the 10-minute cron into a request to a host the
// user never talked to.
const PUSH_HOST =
  /^(?:fcm\.googleapis\.com|android\.googleapis\.com|(?:[a-z0-9-]+\.)?push\.services\.mozilla\.com|(?:[a-z0-9-]+\.)*push\.apple\.com|(?:[a-z0-9-]+\.)*notify\.windows\.com)$/;

const KEY = /^[A-Za-z0-9+/_=-]+$/;

export function vapidSubject(): string | null {
  const subject = process.env.VAPID_SUBJECT?.trim() ?? "";
  if (subject.startsWith("mailto:") && subject.length > "mailto:".length) return subject;
  if (subject.startsWith("https://")) return subject;
  return null;
}

export function isPushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && vapidSubject());
}

export function vapidPublicKey(): string | null {
  return isPushConfigured() ? process.env.VAPID_PUBLIC_KEY! : null;
}

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  return PUSH_HOST.test(url.hostname);
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 256 && KEY.test(value);
}

// The shape `PushSubscription.toJSON()` produces in the browser. Anything else is refused
// rather than stored, including a missing key: the sender can't encrypt to it.
export function parsePushSubscription(input: unknown): PushSubscriptionRecord | null {
  if (!input || typeof input !== "object") return null;
  const body = input as Record<string, unknown>;
  if (typeof body.endpoint !== "string" || !isPushEndpoint(body.endpoint)) return null;
  if (!body.keys || typeof body.keys !== "object") return null;
  const keys = body.keys as Record<string, unknown>;
  if (!isKey(keys.p256dh) || !isKey(keys.auth)) return null;
  let expirationTime: number | null = null;
  if (body.expirationTime != null) {
    if (typeof body.expirationTime !== "number" || !Number.isFinite(body.expirationTime)) return null;
    expirationTime = body.expirationTime;
  }
  return {
    endpoint: body.endpoint,
    expirationTime,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}
