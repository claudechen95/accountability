// The only caller of the Web Push send. Same seam as lib/sendblue.ts: the ladder decides when,
// this file decides how, and a deployment without VAPID keys simply never enters it.

import { sendNotification, setVapidDetails } from "web-push";
import { isPushConfigured, vapidPublicKey, vapidSubject, type PushSubscriptionRecord } from "./push";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export type PushSendResult = "sent" | "gone" | "failed";

let vapidReady = false;

function ensureVapid(): void {
  if (vapidReady) return;
  setVapidDetails(vapidSubject()!, vapidPublicKey()!, process.env.VAPID_PRIVATE_KEY!);
  vapidReady = true;
}

export async function sendPush(sub: PushSubscriptionRecord, payload: PushPayload): Promise<PushSendResult> {
  if (!isPushConfigured()) return "failed";
  ensureVapid();
  try {
    await sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
      // An hour, not the library's four-week default: a reminder from yesterday morning is
      // noise. `topic` collapses anything still queued, so a phone that was off gets the latest
      // list rather than one notification per slot it missed. `high` asks the device to show it
      // now instead of waiting for the next radio wake.
      { TTL: 60 * 60, urgency: "high", topic: "nudge" },
    );
    return "sent";
  } catch (err) {
    const status = statusCode(err);
    // 404 and 410 are the push service saying this subscription is done (app removed, or the
    // browser rotated it away). Anything else is a blip and the next slot can try again.
    if (status === 404 || status === 410) return "gone";
    console.error("Web push failed:", status || (err instanceof Error ? err.message : "unknown"));
    return "failed";
  }
}

function statusCode(err: unknown): number {
  if (!err || typeof err !== "object" || !("statusCode" in err)) return 0;
  const status = Number((err as { statusCode: unknown }).statusCode);
  return Number.isFinite(status) ? status : 0;
}
