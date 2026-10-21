"use client";

import { useEffect, useState } from "react";
import { dampenPull, isVerticalPull, shouldRefresh } from "@/lib/pull";

const BLOCKED = "button, a, input, textarea, select, label, [role='dialog'], .fixed.inset-0";

function scrollTop(): number {
  return window.scrollY || document.documentElement.scrollTop || 0;
}

function blockedTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(BLOCKED));
}

export default function PullToRefresh() {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let armed = false;
    let vertical: boolean | null = null;
    let pulled = 0;

    function reset() {
      armed = false;
      vertical = null;
      pulled = 0;
      setDistance(0);
    }

    function onStart(event: TouchEvent) {
      if (refreshing || event.touches.length !== 1) return;
      if (scrollTop() > 0 || blockedTarget(event.target)) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      armed = true;
      vertical = null;
      pulled = 0;
    }

    function onMove(event: TouchEvent) {
      if (!armed) return;
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      const dx = event.touches[0].clientX - startX;
      const dy = event.touches[0].clientY - startY;
      if (vertical === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        vertical = isVerticalPull(dx, dy);
        if (!vertical) {
          reset();
          return;
        }
      }
      if (scrollTop() > 0) {
        reset();
        return;
      }
      if (event.cancelable) event.preventDefault();
      pulled = dampenPull(dy);
      setDistance(pulled);
    }

    function onEnd() {
      if (!armed) return;
      const reload = shouldRefresh(pulled);
      armed = false;
      vertical = null;
      if (!reload) {
        pulled = 0;
        setDistance(0);
        return;
      }
      setRefreshing(true);
      window.location.reload();
    }

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", reset);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", reset);
    };
  }, [refreshing]);

  const label = refreshing ? "Refreshing..." : shouldRefresh(distance) ? "Release to refresh" : "Pull to refresh";
  const open = distance > 0 || refreshing;

  return (
    <div
      className="pointer-events-none flex items-end justify-center overflow-hidden"
      style={
        open
          ? { height: `calc(${distance}px + env(safe-area-inset-top))`, paddingTop: "env(safe-area-inset-top)" }
          : { height: 0 }
      }
      aria-hidden={!open}
    >
      <div className="mb-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm">
        {label}
      </div>
    </div>
  );
}
