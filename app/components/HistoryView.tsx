"use client";

import React, { useEffect, useState, useCallback } from "react";
import type { Goal, TargetChange } from "@/lib/types";
import { buildTargetTrend, daysBetween, monthTicks, targetLevels } from "@/lib/target-history";

const PST = "America/Los_Angeles";

function getTodayPST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PST }).format(new Date());
}

interface HistoryEntry {
  period: string;
  count: number;
  done: boolean;
  vacation: boolean;
  graduated: boolean; // day falls after the habit graduated, so nothing was expected on it
}

interface GoalHistory {
  goal: Goal;
  entries: HistoryEntry[];
  streak: number;
  reflections: Record<string, string>;
  targetHistory: TargetChange[];
}

// --- Tooltip ---
function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="relative group">
      {children}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-10 pointer-events-none">
        <div className="bg-gray-900 text-white text-[10px] rounded px-2 py-1 whitespace-pre-line max-w-[180px] text-center">
          {text}
        </div>
      </div>
    </div>
  );
}

// --- Backfill confirmation modal ---
function BackfillModal({
  period,
  goalName,
  goalEmoji,
  reflection,
  onConfirm,
  onCancel,
  saving,
}: {
  period: string;
  goalName: string;
  goalEmoji: string;
  reflection?: string;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const dateLabel = new Date(period + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{goalEmoji}</span>
          <div>
            <h2 className="text-base font-semibold text-gray-900">{goalName}</h2>
            <p className="text-xs text-gray-400">{dateLabel}</p>
          </div>
        </div>
        {reflection && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <p className="text-xs font-medium text-amber-600 uppercase tracking-wide mb-1">Your reflection</p>
            <p className="text-sm text-gray-700 leading-snug">“{reflection}”</p>
          </div>
        )}
        <div className="space-y-1">
          <p className="text-sm text-gray-700">Mark this day as completed?</p>
          <p className="text-xs text-gray-400">Use this if you did it but forgot to log at the time.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            disabled={saving}
            className="flex-1 bg-gray-900 text-white rounded-xl py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Yes, backfill it"}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Daily calendar grid (13 weeks × 7 days) ---
function DailyGrid({
  entries,
  frequency,
  reflections,
  onBackfill,
}: {
  entries: HistoryEntry[];
  frequency: "daily" | "weekly";
  reflections: Record<string, string>;
  onBackfill?: (period: string) => void;
}) {
  const today = getTodayPST();

  const firstDate = new Date((entries[0]?.period ?? today) + "T12:00:00");
  const dayOfWeek = (firstDate.getDay() + 6) % 7;
  const paddedEntries: (HistoryEntry | null)[] = [
    ...Array(dayOfWeek).fill(null),
    ...entries,
  ];
  while (paddedEntries.length % 7 !== 0) paddedEntries.push(null);

  const weeks: (HistoryEntry | null)[][] = [];
  for (let i = 0; i < paddedEntries.length; i += 7) {
    weeks.push(paddedEntries.slice(i, i + 7));
  }

  const dayLabels = ["M", "T", "W", "T", "F", "S", "Su"];

  return (
    <div>
      <div className="flex gap-1">
        <div className="flex flex-col gap-1 mr-1">
          <div className="h-3" />
          {dayLabels.map((d, i) => (
            <div key={i} className="w-4 h-3 flex items-center justify-start text-[9px] text-gray-400">
              {i % 2 === 0 ? d : ""}
            </div>
          ))}
        </div>
        {weeks.map((week, wi) => {
          const firstReal = week.find((e) => e !== null);
          const showMonth =
            firstReal && (wi === 0 || firstReal.period.endsWith("-01"));
          const monthLabel = firstReal
            ? new Date(firstReal.period + "T12:00:00").toLocaleDateString("en-US", { month: "short" })
            : "";

          return (
            <div key={wi} className="flex flex-col gap-1">
              <div className="h-3 flex items-end justify-center">
                {showMonth && (
                  <span className="text-[9px] text-gray-400 leading-none">{monthLabel}</span>
                )}
              </div>
              {week.map((entry, di) => {
                if (!entry) {
                  return <div key={di} className="w-3 h-3 rounded-sm bg-transparent" />;
                }
                const isFuture = entry.period > today;
                const isToday = entry.period === today;
                const isMissed =
                  !isFuture && !isToday && !entry.done && !entry.vacation && !entry.graduated;
                const reflection = isMissed ? reflections[entry.period] : undefined;
                const color = isFuture
                  ? "bg-gray-100"
                  : entry.done
                  ? "bg-green-500"
                  : entry.vacation
                  ? "bg-sky-200"
                  : entry.graduated
                  ? "bg-gray-100"
                  : reflection
                  ? "bg-amber-300"
                  : "bg-gray-200";
                const label = new Date(entry.period + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "short", month: "short", day: "numeric",
                });
                const status = isFuture
                  ? ""
                  : entry.graduated
                  ? ` · 🎓 graduated`
                  : frequency === "weekly"
                  ? ""
                  : entry.done
                  ? ` · ✓`
                  : entry.vacation
                  ? ` · 🌴 vacation`
                  : isToday
                  ? ""
                  : ` · ✗ missed`;
                const retroHint = isMissed && onBackfill ? "\ntap to backfill" : "";
                const tooltipText = reflection
                  ? `${label}${status}\n"${reflection.length > 80 ? reflection.slice(0, 80) + "…" : reflection}"${retroHint}`
                  : `${label}${status}${retroHint}`;
                const clickable = isMissed && !!onBackfill;
                return (
                  <Tooltip key={di} text={tooltipText}>
                    <div
                      className={`w-3 h-3 rounded-sm ${color} transition-colors ${clickable ? "cursor-pointer hover:opacity-70 active:scale-90" : "cursor-default"}`}
                      onClick={() => clickable && onBackfill!(entry.period)}
                    />
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 mt-2 text-[10px] text-gray-400">
        <div className="w-3 h-3 rounded-sm bg-gray-200" />
        <span>missed</span>
        <div className="w-3 h-3 rounded-sm bg-amber-300" />
        <span>reflected</span>
        <div className="w-3 h-3 rounded-sm bg-sky-200" />
        <span>vacation</span>
        <div className="w-3 h-3 rounded-sm bg-green-500" />
        <span>done</span>
        {/* Only worth a swatch on a grid that actually has graduated days in it. */}
        {entries.some((e) => e.graduated) && (
          <>
            <div className="w-3 h-3 rounded-sm bg-gray-100 border border-gray-200" />
            <span>graduated</span>
          </>
        )}
      </div>
    </div>
  );
}

// --- Target over time ---
// A step line of what the habit has asked of the user, so a ramp-up (or a scaling back) is
// visible next to the grid of whether they actually did it. Purely a record: the grid above it
// still scores every past day against the habit's current target.
const CHART = { width: 300, height: 84, padLeft: 46, padRight: 6, padTop: 10, padBottom: 18 };
const UP = "#22c55e";   // green-500, same green the grid uses for a completed day
const DOWN = "#fbbf24"; // amber-400

function TargetTrendChart({ changes }: { changes: TargetChange[] }) {
  const trend = buildTargetTrend(changes, getTodayPST());
  if (!trend) return null; // target never moved — a flat line is just noise

  const plotWidth = CHART.width - CHART.padLeft - CHART.padRight;
  const plotHeight = CHART.height - CHART.padTop - CHART.padBottom;
  const totalDays = Math.max(1, daysBetween(trend.domainStart, trend.domainEnd));
  const span = trend.maxPerWeek - trend.minPerWeek;

  const x = (date: string) =>
    CHART.padLeft + (daysBetween(trend.domainStart, date) / totalDays) * plotWidth;
  // A reshape that doesn't change the weekly total has nothing to slope between, so it sits on
  // the middle of the axis rather than dividing by a zero span.
  const y = (perWeek: number) =>
    span === 0
      ? CHART.padTop + plotHeight / 2
      : CHART.padTop + (1 - (perWeek - trend.minPerWeek) / span) * plotHeight;

  const points: [number, number][] = [];
  trend.segments.forEach((segment) => {
    points.push([x(segment.start), y(segment.perWeek)]);
    points.push([x(segment.end), y(segment.perWeek)]);
  });
  const path = (pts: [number, number][]) =>
    pts.map(([px, py], i) => `${i === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");

  // The stretch before the first recorded change has no known start date, so it's drawn dashed
  // and running off the left edge rather than pretending the habit began there.
  const leadIn = trend.openStart ? points.slice(0, 2) : [];
  const solid = trend.openStart ? points.slice(1) : points;

  const ticks = monthTicks(trend).filter(
    (tick, i, all) => i === 0 || x(tick.date) - x(all[i - 1].date) > 24
  );
  const latest = trend.steps[trend.steps.length - 1];
  const latestLabel = new Date(latest.date + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  return (
    <div className="mt-5 pt-4 border-t border-gray-100">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Target over time</p>
      <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} className="w-full" role="img" aria-label="Target over time">
        {targetLevels(trend).map((level) => (
          <g key={level.perWeek}>
            <line
              x1={CHART.padLeft}
              x2={CHART.width - CHART.padRight}
              y1={y(level.perWeek)}
              y2={y(level.perWeek)}
              stroke="#f3f4f6"
              strokeWidth={1}
            />
            <text
              x={CHART.padLeft - 6}
              y={y(level.perWeek) + 3}
              textAnchor="end"
              fontSize={9}
              fill="#9ca3af"
            >
              {level.label}
            </text>
          </g>
        ))}

        {leadIn.length > 0 && (
          <path d={path(leadIn)} fill="none" stroke="#d1d5db" strokeWidth={1.5} strokeDasharray="3 3" />
        )}
        <path d={path(solid)} fill="none" stroke="#111827" strokeWidth={1.5} strokeLinejoin="round" />

        {trend.steps.map((step) => (
          <circle
            key={step.date}
            cx={x(step.date)}
            cy={y(step.to.perWeek)}
            r={2.6}
            fill="#ffffff"
            stroke={step.direction === "up" ? UP : DOWN}
            strokeWidth={1.8}
          >
            <title>{`${step.from.label} → ${step.to.label} · ${step.date}`}</title>
          </circle>
        ))}
        <circle cx={x(trend.domainEnd)} cy={y(trend.segments[trend.segments.length - 1].perWeek)} r={2} fill="#111827" />

        {ticks.map((tick) => (
          <text key={tick.date} x={x(tick.date)} y={CHART.height - 5} textAnchor="middle" fontSize={9} fill="#9ca3af">
            {tick.label}
          </text>
        ))}
      </svg>
      <p className="text-[11px] text-gray-400 mt-1">
        <span className={latest.direction === "up" ? "text-green-600" : "text-amber-500"}>
          {latest.direction === "up" ? "↑" : "↓"}
        </span>{" "}
        {latest.from.label} → {latest.to.label} on {latestLabel}
      </p>
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <div className="text-xl font-bold text-gray-900">{value}</div>
      <div className="text-xs text-gray-400">{label}</div>
    </div>
  );
}

function GoalHistoryCard({
  goalHistory,
  onBackfill,
}: {
  goalHistory: GoalHistory;
  onBackfill: (goalId: string, period: string) => void;
}) {
  const { goal, entries, streak, reflections, targetHistory } = goalHistory;
  const today = getTodayPST();
  const doneCount = entries.filter((e) => e.done).length;
  // Days after graduation were never expected, so they'd only drag the completion rate down
  // for a habit the user was told to stop tracking.
  const totalPast = entries.filter((e) => e.period <= today && !e.graduated).length;
  const rate = totalPast > 0 ? Math.round((doneCount / totalPast) * 100) : 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-2xl">{goal.emoji}</span>
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-1.5">
            {goal.name}
            {goal.graduatedAt && (
              <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5">
                🎓 graduated
              </span>
            )}
          </h2>
          <p className="text-xs text-gray-400">{goal.targetCount}x {goal.frequency}</p>
        </div>
      </div>

      <div className="flex justify-around mb-5 py-3 bg-gray-50 rounded-xl">
        <StatPill label="completion" value={`${rate}%`} />
        <div className="w-px bg-gray-200" />
        <StatPill label="check-ins" value={doneCount} />
        <div className="w-px bg-gray-200" />
        {/* Days for a daily habit, weeks for a weekly one. Spelled out because a bare "🔥 9" on a
            grid that shows three months reads as weeks even when it's days. */}
        <StatPill
          label={goal.frequency === "daily" ? "day streak" : "week streak"}
          value={streak > 0 ? `🔥 ${streak}` : "—"}
        />
      </div>

      <DailyGrid
        entries={entries}
        frequency={goal.frequency}
        reflections={reflections}
        onBackfill={(period) => onBackfill(goal.id, period)}
      />

      <TargetTrendChart changes={targetHistory ?? []} />
    </div>
  );
}

interface BackfillTarget {
  goalId: string;
  goalName: string;
  goalEmoji: string;
  period: string;
  reflection?: string;
}

export function HistoryPage({ userId }: { userId?: string }) {
  const [history, setHistory] = useState<GoalHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backfillTarget, setBackfillTarget] = useState<BackfillTarget | null>(null);
  const [backfillSaving, setRetroSaving] = useState(false);

  const q = userId ? `?user=${encodeURIComponent(userId)}` : "";

  const loadHistory = useCallback(() => {
    fetch(`/api/history${q}`)
      .then((r) => r.json())
      .then((data) => setHistory(data))
      .catch(() => setError("Couldn't load history."))
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleBackfill = (goalId: string, period: string) => {
    const gh = history.find((h) => h.goal.id === goalId);
    if (!gh) return;
    setBackfillTarget({
      goalId,
      period,
      goalName: gh.goal.name,
      goalEmoji: gh.goal.emoji,
      reflection: gh.reflections[period],
    });
  };

  const confirmBackfill = async () => {
    if (!backfillTarget) return;
    setRetroSaving(true);
    try {
      await fetch(`/api/checkins${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId: backfillTarget.goalId, date: backfillTarget.period }),
      });
      setBackfillTarget(null);
      setLoading(true);
      loadHistory();
    } finally {
      setRetroSaving(false);
    }
  };

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      <div className="flex items-center gap-3 mb-8">
        <h1 className="text-2xl font-bold text-gray-900">History</h1>
      </div>

      {loading && (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="rounded-2xl bg-white border border-gray-200 p-5 h-52 animate-pulse" />
          ))}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-4">
          {history.map((gh) => (
            <GoalHistoryCard key={gh.goal.id} goalHistory={gh} onBackfill={handleBackfill} />
          ))}
        </div>
      )}

      {backfillTarget && (
        <BackfillModal
          period={backfillTarget.period}
          goalName={backfillTarget.goalName}
          goalEmoji={backfillTarget.goalEmoji}
          reflection={backfillTarget.reflection}
          onConfirm={confirmBackfill}
          onCancel={() => setBackfillTarget(null)}
          saving={backfillSaving}
        />
      )}
    </main>
  );
}
