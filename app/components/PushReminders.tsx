"use client";

import { useEffect, useState } from "react";
import { timedFetch } from "@/lib/client-perf";

type Phase = "pending" | "hidden" | "ios" | "off" | "on" | "denied";

function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS reports itself as a Mac, and a Mac has no touch points.
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushReminders({ userId }: { userId?: string }) {
  const [phase, setPhase] = useState<Phase>("pending");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = `?user=${encodeURIComponent(userId || "alan")}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await timedFetch(`/api/push${q}`);
        if (!res.ok) throw new Error("status");
        const data = (await res.json()) as {
          configured?: boolean;
          publicKey?: string | null;
          endpoints?: string[];
        };
        if (cancelled) return;
        if (!data.configured || !data.publicKey) {
          setPhase("hidden");
          return;
        }
        setPublicKey(data.publicKey);
        if (isIos() && !isStandalone()) {
          setPhase("ios");
          return;
        }
        if (!("serviceWorker" in navigator) || !("PushManager" in window) || !window.isSecureContext) {
          setPhase("hidden");
          return;
        }
        const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (Notification.permission === "denied") {
          setPhase("denied");
          return;
        }
        const endpoints = data.endpoints ?? [];
        setPhase(sub && endpoints.includes(sub.endpoint) ? "on" : "off");
      } catch {
        if (!cancelled) setPhase("hidden");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q]);

  // Already on: the card is the offer, and the offer is done. Turning it off is a browser setting.
  if (phase === "pending" || phase === "hidden" || phase === "on") return null;

  async function enable() {
    if (busy || !publicKey) return;
    setBusy(true);
    setError(null);
    try {
      // First await in the click. iOS drops the prompt if anything else is awaited before it.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPhase(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      const saved = await timedFetch(`/api/push${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!saved.ok) throw new Error("Couldn't turn reminders on.");
      setPhase("on");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn reminders on.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-4">
      {phase === "ios" && (
        <>
          <p className="text-sm font-semibold text-gray-900">Reminders on this iPhone</p>
          <p className="mt-1 text-sm text-gray-600">
            Tap Share, then Add to Home Screen. Open Accountability from that icon to turn reminders on.
          </p>
        </>
      )}
      {phase === "off" && (
        <>
          <p className="text-sm font-semibold text-gray-900">Reminders on this device</p>
          <p className="mt-1 text-sm text-gray-600">A notification when a habit is still open, and when your partner checks one in.</p>
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-gray-900 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? "Turning on..." : "Turn on reminders"}
          </button>
        </>
      )}
      {phase === "denied" && (
        <>
          <p className="text-sm font-semibold text-gray-900">Reminders are blocked</p>
          <p className="mt-1 text-sm text-gray-600">Allow notifications for this site in the browser settings, then come back.</p>
        </>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
