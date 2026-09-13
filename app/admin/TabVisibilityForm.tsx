"use client";

import { useState } from "react";
import { HIDEABLE_TABS } from "@/lib/tabs";

/**
 * Switches bottom-nav tabs on and off for one user. Checked = shown, which is the way round the
 * nav reads even though Redis stores the *hidden* set - a user record with nothing stored shows
 * everything, so "hidden" is the right thing to persist and the wrong thing to ask about.
 *
 * Home is absent because it can't be hidden. The whole set is PATCHed at once, so there's no
 * per-tab request to half-fail.
 */
export default function TabVisibilityForm({
  id,
  hiddenTabs,
}: {
  id: string;
  hiddenTabs: string[];
}) {
  const [hidden, setHidden] = useState<string[]>(hiddenTabs);
  const [saving, setSaving] = useState(false);

  async function toggle(key: string) {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
    setHidden(next);
    setSaving(true);
    await fetch("/api/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, hiddenTabs: next }),
    });
    setSaving(false);
  }

  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-gray-400 w-24 flex-shrink-0 pt-0.5">
        Tabs {saving && <span className="text-gray-300 text-xs">·</span>}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {HIDEABLE_TABS.map((tab) => {
          const shown = !hidden.includes(tab.key);
          return (
            <button
              key={tab.key}
              onClick={() => toggle(tab.key)}
              aria-pressed={shown}
              className={`text-xs px-2 py-1 rounded-lg border transition-colors ${
                shown
                  ? "bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100"
                  : "bg-white border-gray-200 text-gray-300 line-through hover:text-gray-400"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
