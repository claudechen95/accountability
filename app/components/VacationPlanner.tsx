"use client";

import { useMemo, useState } from "react";
import type { Goal } from "@/lib/types";
import { mondayOfWeekKey, weeksInRange, addDaysToDateStr } from "@/lib/dates";
import { timedFetch } from "@/lib/client-perf";

/**
 * Planning a vacation habit by habit, week by week.
 *
 * The old form was a list of checkboxes: tick the habits to pause, pick two dates, done. What it
 * couldn't express is the middle - "the gym's off but I'm keeping the stretching", "three piano
 * sessions instead of five" - so a trip was all-or-nothing per habit, and ticking everything was
 * the path of least resistance.
 *
 * Every habit needs an explicit number for every week the trip touches, and **nothing is
 * prefilled**. A default would be the unconsidered choice this exists to replace: the point is
 * that the user decides in advance what each week is for, rather than discovering on the Friday
 * that they're three sessions behind on a week they were never going to practise.
 */

/** What the user has decided for one habit in one week. */
interface Choice {
  targetCount: number;
  nudgeTime?: string;
  nudgeDays?: number[];
  nudgeEnabled?: boolean;
}

type Plan = Record<string, Record<string, Choice>>; // week -> goalId -> choice

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function weekRangeLabel(week: string): string {
  const monday = mondayOfWeekKey(week);
  const sunday = addDaysToDateStr(monday, 6);
  const fmt = (d: string) =>
    new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

function targetLabel(goal: Goal, count: number): string {
  if (count === 0) return "Skip";
  return goal.frequency === "daily" ? `${count}x/day` : `${count}x`;
}

function HabitRow({
  goal,
  choice,
  onChange,
}: {
  goal: Goal;
  choice: Choice | undefined;
  onChange: (next: Choice | undefined) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const decided = choice !== undefined;
  const keep = goal.targetCount;

  const set = (over: Partial<Choice>) =>
    onChange({ targetCount: choice?.targetCount ?? keep, ...choice, ...over });

  const pill = (active: boolean) =>
    `px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
      active
        ? "bg-gray-900 text-white border-gray-900"
        : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
    }`;

  return (
    <div className={`rounded-xl border p-2.5 ${decided ? "border-gray-200" : "border-amber-200 bg-amber-50/40"}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-800 flex-1 min-w-0 truncate">
          {/* Spaced like the habit cards on the home screen - a bare space between the emoji and
              the name renders tight enough to read as one word. */}
          <span className="mr-1.5">{goal.emoji}</span>
          {goal.name}
        </span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button type="button" className={pill(choice?.targetCount === 0)} onClick={() => { setCustom(false); set({ targetCount: 0 }); }}>
            Skip
          </button>
          <button
            type="button"
            className={pill(decided && !custom && choice?.targetCount === keep)}
            onClick={() => { setCustom(false); set({ targetCount: keep }); }}
          >
            {targetLabel(goal, keep)}
          </button>
          <button
            type="button"
            className={pill(custom)}
            onClick={() => { setCustom(true); set({ targetCount: choice?.targetCount || keep }); }}
          >
            Other
          </button>
        </div>
      </div>

      {custom && (
        <div className="flex items-center gap-2 mt-2 pl-1">
          <input
            type="number"
            min={0}
            max={goal.frequency === "daily" ? 20 : 7}
            value={choice?.targetCount ?? keep}
            onChange={(e) => set({ targetCount: Math.max(0, Number(e.target.value) || 0) })}
            className="w-16 border border-gray-200 rounded-lg px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300"
          />
          <span className="text-xs text-gray-500">
            {goal.frequency === "daily" ? "times a day" : "times that week"}
          </span>
        </div>
      )}

      {/* A reminder set for an ordinary evening at home is rarely the one you want from three
          time zones away, so the week can carry its own. */}
      {decided && choice!.targetCount > 0 && (
        <div className="mt-2 pl-1">
          <button
            type="button"
            onClick={() => setNudgeOpen((v) => !v)}
            className="text-[11px] text-gray-400 hover:text-gray-600 underline"
          >
            {nudgeOpen ? "hide nudges" : "nudges for this week"}
          </button>
          {nudgeOpen && (
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={choice!.nudgeEnabled === false}
                  onChange={(e) => set({ nudgeEnabled: e.target.checked ? false : undefined })}
                  className="w-3.5 h-3.5 rounded border-gray-300"
                />
                No reminders this week
              </label>
              {choice!.nudgeEnabled !== false && (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">At</span>
                    <input
                      type="time"
                      value={choice!.nudgeTime ?? goal.nudgeTime ?? "21:00"}
                      onChange={(e) => set({ nudgeTime: e.target.value })}
                      className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300"
                    />
                  </div>
                  {goal.frequency === "weekly" && (
                    <div className="flex items-center gap-1">
                      {DAY_LABELS.map((label, day) => {
                        const days = choice!.nudgeDays ?? goal.nudgeDays ?? [];
                        const on = days.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() =>
                              set({ nudgeDays: on ? days.filter((d) => d !== day) : [...days, day].sort() })
                            }
                            className={`w-6 h-6 rounded-full text-[10px] font-medium transition-colors ${
                              on ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function VacationPlanner({
  goals,
  userId,
  today,
  onSaved,
  onCancel,
}: {
  goals: Goal[];
  userId?: string;
  today: string;
  onSaved: (data: unknown) => void;
  onCancel: () => void;
}) {
  const [startDate, setStartDate] = useState(today);
  // Six days, not seven: a week away that starts on a Monday should open as one week to plan
  // rather than two, and every extra week the default spans is a full set of habits to decide on
  // before the form will save.
  const [endDate, setEndDate] = useState(addDaysToDateStr(today, 6));
  const [plan, setPlan] = useState<Plan>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const weeks = useMemo(
    () => (startDate && endDate && endDate >= startDate ? weeksInRange(startDate, endDate) : []),
    [startDate, endDate]
  );
  const plannable = goals.filter((g) => !g.graduatedAt);
  const remaining = weeks.reduce(
    (n, week) => n + plannable.filter((g) => plan[week]?.[g.id] === undefined).length,
    0
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const q = userId ? `?user=${encodeURIComponent(userId)}` : "";
      const res = await timedFetch(`/api/vacation${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          plan: weeks.map((week) => ({ week, goals: plan[week] ?? {} })),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      onSaved(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the plan.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6 rounded-2xl border border-gray-200 bg-white shadow-sm p-4 space-y-3">
      <div>
        <p className="text-sm text-gray-700">Plan the trip habit by habit.</p>
        <p className="text-xs text-gray-400 mt-0.5">
          Every habit needs a call for every week you&rsquo;re away. Skip is a real answer - those
          days stop counting against you.
        </p>
      </div>

      <div className="flex items-center gap-2 pb-1">
        <span className="text-sm text-gray-500">From:</span>
        <input
          type="date"
          min={today}
          value={startDate}
          onChange={(e) => {
            const next = e.target.value;
            setStartDate(next);
            if (endDate < next) setEndDate(next);
          }}
          className="border border-gray-200 rounded-xl px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300"
        />
        <span className="text-sm text-gray-500">Until:</span>
        <input
          type="date"
          min={startDate}
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="border border-gray-200 rounded-xl px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300"
        />
      </div>

      {weeks.map((week) => {
        const left = plannable.filter((g) => plan[week]?.[g.id] === undefined).length;
        return (
          <div key={week} className="space-y-1.5 pt-2 border-t border-gray-100">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                {weekRangeLabel(week)}
              </p>
              <span className={`text-[11px] ${left === 0 ? "text-emerald-600" : "text-amber-600"}`}>
                {left === 0 ? "all set" : `${left} to go`}
              </span>
            </div>
            {plannable.map((goal) => (
              <HabitRow
                key={goal.id}
                goal={goal}
                choice={plan[week]?.[goal.id]}
                onChange={(next) =>
                  setPlan((prev) => ({
                    ...prev,
                    [week]: { ...prev[week], [goal.id]: next as Choice },
                  }))
                }
              />
            ))}
          </div>
        );
      })}

      {error && (
        <p className="text-xs text-red-600">{error}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <span className="text-[11px] text-gray-400">
          {remaining === 0 ? "Every week planned." : `${remaining} habit-week${remaining === 1 ? "" : "s"} left to decide.`}
        </span>
        <button
          onClick={save}
          disabled={saving || remaining > 0 || weeks.length === 0}
          className="ml-auto bg-gray-900 text-white rounded-xl px-4 py-1.5 text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : startDate > today ? "Schedule" : "Start"}
        </button>
        <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600 underline">
          cancel
        </button>
      </div>
    </div>
  );
}
