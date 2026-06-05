"use client";

import React, { useEffect, useState } from "react";
import type { MoodEntry } from "@/lib/types";

const PST = "America/Los_Angeles";

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: PST,
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: PST,
  });
}

function getTodayPST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PST }).format(new Date());
}

interface DayGroup {
  date: string;
  entries: MoodEntry[];
}

function groupByDate(entries: MoodEntry[]): DayGroup[] {
  const map = new Map<string, MoodEntry[]>();
  for (const entry of entries) {
    if (!map.has(entry.date)) map.set(entry.date, []);
    map.get(entry.date)!.push(entry);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, entries]) => ({ date, entries }));
}

export default function MoodPage() {
  const [groups, setGroups] = useState<DayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const today = getTodayPST();

  useEffect(() => {
    fetch("/api/mood?date=all")
      .then((r) => r.json())
      .then((data: MoodEntry[]) => setGroups(groupByDate(data)))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      <div className="flex items-center gap-3 mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Mood Journal</h1>
      </div>

      {loading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl bg-white border border-gray-200 p-5 h-28 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && groups.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">🧠</div>
          <p className="text-sm">No check-ins yet.</p>
          <p className="text-xs mt-1">Log your first emotion from the home screen.</p>
        </div>
      )}

      {!loading && groups.length > 0 && (
        <div className="space-y-6">
          {groups.map(({ date, entries }) => (
            <div key={date}>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                {date === today ? "Today" : formatDate(date)}
              </p>
              <div className="space-y-2">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3 flex items-start gap-3"
                  >
                    <span className="text-3xl leading-none mt-0.5">{entry.emoji}</span>
                    <div className="flex-1 min-w-0">
                      {entry.text ? (
                        <p className="text-sm text-gray-800 leading-snug">{entry.text}</p>
                      ) : (
                        <p className="text-sm text-gray-400 italic">No note</p>
                      )}
                      <p className="text-[11px] text-gray-300 mt-1">{formatTime(entry.timestamp)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
