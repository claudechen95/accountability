"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import type { Goal, TargetChange } from "@/lib/types";
import { buildTargetTrend, daysBetween, monthTicks, targetLevels } from "@/lib/target-history";
import { timedFetch, logFirstData } from "@/lib/client-perf";

const PST = "America/Los_Angeles";

function getTodayPST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PST }).format(new Date());
}

interface HistoryEntry {
  period: string;
  count: number;
  done: boolean;
  vacation: boolean;
}

interface GoalHistory {
  goal: Goal;
  entries: HistoryEntry[];
  streak: number;
  reflections: Record<string, string>;
  targetHistory: TargetChange[];
}

/**
 * `initialHistory` is rendered on the server by the page wrapper, so the grids are in the HTML
 * rather than fetched after hydration. Optional - without it this fetches on mount as before,
 * which is what a client-side navigation into this view does.
 */

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
          // A column is labelled with the month that *starts* inside it, falling back to whatever
          // month the leftmost column opens in. Keying off the column's first day being the 1st
          // only labelled a month when its 1st happened to land on a Monday, so a 13-week grid
          // usually came out with one tick on it instead of three.
          const firstReal = week.find((e) => e !== null);
          const monthStart = week.find((e) => e?.period.endsWith("-01"));
          const labelled = monthStart ?? (wi === 0 ? firstReal : undefined);
          const monthLabel = labelled
            ? new Date(labelled.period + "T12:00:00").toLocaleDateString("en-US", { month: "short" })
            : "";

          return (
            <div key={wi} className="flex flex-col gap-1">
              <div className="h-3 flex items-end justify-center">
                {labelled && (
                  <span className="text-[9px] text-gray-400 leading-none">{monthLabel}</span>
                )}
              </div>
              {week.map((entry, di) => {
                if (!entry) {
                  return <div key={di} className="w-3 h-3 rounded-sm bg-transparent" />;
                }
                const isFuture = entry.period > today;
                const isToday = entry.period === today;
                const isMissed = !isFuture && !isToday && !entry.done && !entry.vacation;
                // A reflection shows wherever it was written, not only on a missed day. A weekly
                // goal files its reflection under the day it was written (`getReflectionDateKey`),
                // and that day is checked in seconds later - so gating this on `isMissed` hid
                // every reflection a weekly habit has ever collected.
                const reflection = reflections[entry.period];
                const color = isFuture
                  ? "bg-gray-100"
                  : entry.done
                  ? "bg-green-500"
                  : entry.vacation
                  ? "bg-sky-200"
                  : "bg-gray-200";
                // Fill carries the outcome and the ring carries "there's a reflection here", so
                // neither can hide the other - an amber fill on a missed day used to mean the
                // grid couldn't say "missed" and "reflected" at once.
                const ring = reflection ? " ring-1 ring-inset ring-amber-500" : "";
                const label = new Date(entry.period + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "short", month: "short", day: "numeric",
                });
                const status = isFuture
                  ? ""
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
                      className={`w-3 h-3 rounded-sm ${color}${ring} transition-colors ${clickable ? "cursor-pointer hover:opacity-70 active:scale-90" : "cursor-default"}`}
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
        <div className="w-3 h-3 rounded-sm bg-gray-200 ring-1 ring-inset ring-amber-500" />
        <span>reflected</span>
        <div className="w-3 h-3 rounded-sm bg-sky-200" />
        <span>vacation</span>
        <div className="w-3 h-3 rounded-sm bg-green-500" />
        <span>done</span>
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

function TargetTrendChart({ changes, endDate }: { changes: TargetChange[]; endDate: string }) {
  const trend = buildTargetTrend(changes, endDate);
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
  // A graduated habit's window already ends at its graduation, so every entry in it is a day the
  // habit was really being tracked on - there is nothing to exclude here for either kind.
  const doneCount = entries.filter((e) => e.done).length;
  const totalPast = entries.filter((e) => e.period <= today).length;
  const rate = totalPast > 0 ? Math.round((doneCount / totalPast) * 100) : 0;
  const graduatedOn = goal.graduatedAt
    ? new Date(goal.graduatedAt + "T12:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-2xl">{goal.emoji}</span>
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-1.5">
            {goal.name}
            {graduatedOn && (
              <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5">
                🎓 {graduatedOn}
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
            grid that shows three months reads as weeks even when it's days. A graduated habit's
            number was frozen at graduation, so "streak" would read as something still running. */}
        <StatPill
          label={
            goal.graduatedAt
              ? goal.frequency === "daily" ? "final run · days" : "final run · weeks"
              : goal.frequency === "daily" ? "day streak" : "week streak"
          }
          value={streak > 0 ? `🔥 ${streak}` : "—"}
        />
      </div>

      {graduatedOn && (
        <p className="text-[11px] text-gray-400 mb-2">
          The {entries.length} days up to graduation. Nothing is tracked after it.
        </p>
      )}

      <DailyGrid
        entries={entries}
        frequency={goal.frequency}
        reflections={reflections}
        // A graduated habit refuses check-ins server-side, so offering a backfill cell would
        // hand the user a tap that can only come back a 409.
        onBackfill={goal.graduatedAt ? undefined : (period) => onBackfill(goal.id, period)}
      />

      <TargetTrendChart changes={targetHistory ?? []} endDate={goal.graduatedAt ?? today} />
    </div>
  );
}

/**
 * Graduated habits, folded away below the tracked ones - the history-page counterpart of the home
 * screen's trophy shelf, so both places put them in the same box.
 *
 * Collapsed by default, where the shelf is open by default: the shelf is a row of emoji
 * medallions, while these are full cards, so left open they'd push the habits the user is
 * actually tracking off the screen as the shelf grows.
 */
function GraduatedSection({ histories }: { histories: GoalHistory[] }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="pt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-800 transition-colors"
      >
        <span aria-hidden>🏆</span>
        <span>Graduated · {histories.length}</span>
        <svg
          className={`w-3 h-3 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && (
        <div className="space-y-4 mt-3">
          {histories.map((gh) => (
            // No backfill handler: nothing on a graduated card is clickable anyway.
            <GoalHistoryCard key={gh.goal.id} goalHistory={gh} onBackfill={() => {}} />
          ))}
        </div>
      )}
    </section>
  );
}

interface BackfillTarget {
  goalId: string;
  goalName: string;
  goalEmoji: string;
  period: string;
  reflection?: string;
}

export function HistoryPage({
  userId,
  initialHistory,
}: {
  userId?: string;
  initialHistory?: GoalHistory[];
}) {
  const [history, setHistory] = useState<GoalHistory[]>(initialHistory ?? []);
  const [loading, setLoading] = useState(!initialHistory);
  const [error, setError] = useState<string | null>(null);
  const [backfillTarget, setBackfillTarget] = useState<BackfillTarget | null>(null);
  const [backfillSaving, setRetroSaving] = useState(false);

  const q = userId ? `?user=${encodeURIComponent(userId)}` : "";

  // Graduated habits sink below the tracked ones rather than sitting wherever storage order puts
  // them, the same way the home screen lifts them out of the list onto the trophy shelf.
  const tracked = history.filter((gh) => !gh.goal.graduatedAt);
  const graduated = history.filter((gh) => gh.goal.graduatedAt);

  const loadHistory = useCallback(() => {
    timedFetch(`/api/history${q}`)
      .then((r) => r.json())
      .then((data) => setHistory(data))
      .catch(() => setError("Couldn't load history."))
      .finally(() => {
        setLoading(false);
        logFirstData("history");
      });
  }, [q]);

  // Server-rendered data is current as of this request; re-fetching on mount would be a second
  // round trip for an identical answer. Backfills still reload through loadHistory.
  const serverRendered = useRef(!!initialHistory);
  useEffect(() => {
    if (serverRendered.current) {
      serverRendered.current = false;
      logFirstData("history (server-rendered)");
      return;
    }
    loadHistory();
  }, [loadHistory]);

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
      await timedFetch(`/api/checkins${q}`, {
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
          {tracked.map((gh) => (
            <GoalHistoryCard key={gh.goal.id} goalHistory={gh} onBackfill={handleBackfill} />
          ))}
          {graduated.length > 0 && <GraduatedSection histories={graduated} />}
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
