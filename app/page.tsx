"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import versionData from "@/version.json";
import type { Goal, GoalStatus } from "@/lib/types";

const PST = "America/Los_Angeles";

function getTodayPST(): Date {
  const pstStr = new Date().toLocaleString("en-US", { timeZone: PST });
  return new Date(pstStr);
}

function formatPeriod(frequency: "daily" | "weekly"): string {
  const today = getTodayPST();
  if (frequency === "daily") {
    return today.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - (today.getDay() + 6) % 7); // Monday
  return `Week of ${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function StreakBadge({ streak }: { streak: number }) {
  if (streak === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-600 bg-orange-50 border border-orange-200 rounded-full px-2 py-0.5">
      🔥 {streak} {streak === 1 ? "streak" : "in a row"}
    </span>
  );
}

function HabitForm({
  initial,
  onSave,
  onCancel,
  loading,
}: {
  initial?: Goal;
  onSave: (goal: Goal) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [frequency, setFrequency] = useState<"daily" | "weekly">(initial?.frequency ?? "daily");
  const [targetCount, setTargetCount] = useState(initial?.targetCount ?? 1);
  const [nudgeDays, setNudgeDays] = useState<number[]>(initial?.nudgeDays ?? []);
  const [nudgeTime, setNudgeTime] = useState(initial?.nudgeTime ?? "21:00");

  const toggleNudgeDay = (day: number) =>
    setNudgeDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);

  const nudgeActive = frequency === "daily" || (frequency === "weekly" && nudgeDays.length > 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      emoji: emoji.trim() || "✓",
      frequency,
      targetCount,
      nudgeDays: frequency === "weekly" ? nudgeDays : undefined,
      nudgeTime: nudgeActive ? nudgeTime : undefined,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-gray-200 bg-white shadow-sm p-5 space-y-4"
    >
      <div className="flex gap-3">
        <input
          type="text"
          placeholder="😀"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          className="w-14 text-2xl text-center border border-gray-200 rounded-xl p-2 focus:outline-none focus:ring-2 focus:ring-gray-300"
          maxLength={4}
        />
        <input
          type="text"
          placeholder="Habit name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300"
          autoFocus
          required
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="flex rounded-xl border border-gray-200 overflow-hidden text-sm">
          <button
            type="button"
            onClick={() => setFrequency("daily")}
            className={`px-3 py-1.5 transition-colors ${
              frequency === "daily" ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-50"
            }`}
          >
            Daily
          </button>
          <button
            type="button"
            onClick={() => setFrequency("weekly")}
            className={`px-3 py-1.5 transition-colors ${
              frequency === "weekly" ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-50"
            }`}
          >
            Weekly
          </button>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={() => setTargetCount(Math.max(1, targetCount - 1))}
            className="w-7 h-7 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 flex items-center justify-center text-lg leading-none"
          >
            −
          </button>
          <span className="text-sm text-gray-700 w-20 text-center">
            {targetCount}× / {frequency === "daily" ? "day" : "week"}
          </span>
          <button
            type="button"
            onClick={() => setTargetCount(targetCount + 1)}
            className="w-7 h-7 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 flex items-center justify-center text-lg leading-none"
          >
            +
          </button>
        </div>
      </div>

      {frequency === "weekly" && (
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Nudge me on</p>
          <div className="flex gap-1.5">
            {["S","M","T","W","T","F","S"].map((label, day) => (
              <button
                key={day}
                type="button"
                onClick={() => toggleNudgeDay(day)}
                className={`w-8 h-8 rounded-full text-xs font-medium transition-colors ${
                  nudgeDays.includes(day)
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {nudgeActive && (
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Reminder time (PST)</p>
          <input
            type="time"
            value={nudgeTime}
            onChange={(e) => setNudgeTime(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-300"
          />
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={loading || !name.trim()}
          className="flex-1 bg-gray-900 text-white rounded-xl py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {initial ? "Save changes" : "Add habit"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReflectionModal({
  goal,
  onSubmit,
  onSkip,
  onClose,
}: {
  goal: GoalStatus;
  onSubmit: (text: string) => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);
  const today = getTodayPST();
  const periodLabel =
    goal.frequency === "daily"
      ? (() => {
          const yesterday = new Date(today);
          yesterday.setDate(today.getDate() - 1);
          return yesterday.toLocaleDateString("en-US", { weekday: "long" });
        })()
      : "Last week";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{goal.emoji}</span>
            <h2 className="text-base font-semibold text-gray-900">{goal.name}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <p className="text-sm text-gray-700">
          <span className="font-medium">{periodLabel}</span> you missed this.{" "}
          What got in the way?
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Optional — just thinking out loud is enough"
          rows={3}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-gray-300"
          autoFocus
        />

        <div className="flex flex-col gap-2">
          <button
            onClick={() => onSubmit(text)}
            className="w-full bg-gray-900 text-white rounded-xl py-2 text-sm font-medium hover:bg-gray-700 transition-colors"
          >
            {text.trim() ? "Save & Check In" : "Check In"}
          </button>
          <button
            onClick={onSkip}
            className="text-xs text-gray-400 hover:text-gray-600 underline transition-colors"
          >
            just check in, skip reflection
          </button>
        </div>
      </div>
    </div>
  );
}

const WHEEL_EMOTIONS = [
  { emoji: "😄", label: "Excited" },
  { emoji: "🥳", label: "Joyful" },
  { emoji: "😊", label: "Happy" },
  { emoji: "🥰", label: "Loved" },
  { emoji: "😌", label: "Calm" },
  { emoji: "😇", label: "Grateful" },
  { emoji: "💪", label: "Motivated" },
  { emoji: "😎", label: "Confident" },
  { emoji: "🤩", label: "Amazed" },
  { emoji: "😏", label: "Playful" },
  { emoji: "😐", label: "Neutral" },
  { emoji: "🤔", label: "Confused" },
  { emoji: "😔", label: "Down" },
  { emoji: "😢", label: "Sad" },
  { emoji: "😞", label: "Disappointed" },
  { emoji: "😰", label: "Anxious" },
  { emoji: "😨", label: "Scared" },
  { emoji: "😫", label: "Exhausted" },
  { emoji: "😡", label: "Angry" },
  { emoji: "😤", label: "Frustrated" },
];

// Clockwise indices for the tutorial sweep (spread evenly around the wheel)
const TUT_STEPS = [0, 3, 6, 9, 13, 17];

function EmotionWheel({ selected, onSelect }: { selected: string; onSelect: (emoji: string) => void }) {
  const [hovered, setHovered] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [tutStep, setTutStep] = useState<number | null>(0); // null = tutorial done
  const tutTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const size = 260;
  const center = size / 2;
  const radius = 100;
  const n = WHEEL_EMOTIONS.length;

  const stopTutorial = useCallback(() => {
    tutTimers.current.forEach(clearTimeout);
    tutTimers.current = [];
    setTutStep(null);
    setHovered("");
  }, []);

  // Run the tutorial sweep once on mount
  useEffect(() => {
    const DELAY = 500;
    const STEP = 320;
    TUT_STEPS.forEach((idx, i) => {
      const t = setTimeout(() => {
        setTutStep(i);
        setHovered(WHEEL_EMOTIONS[idx].emoji);
      }, DELAY + i * STEP);
      tutTimers.current.push(t);
    });
    const end = setTimeout(() => {
      setHovered("");
      setTutStep(null);
    }, DELAY + TUT_STEPS.length * STEP);
    tutTimers.current.push(end);
    return () => { tutTimers.current.forEach(clearTimeout); };
  }, []);

  const displayEmotion = WHEEL_EMOTIONS.find((e) => e.emoji === (hovered || selected));
  const isPreview = !!hovered && hovered !== selected;

  // Compute tutorial dot position
  const tutPos = tutStep !== null && tutStep < TUT_STEPS.length ? (() => {
    const idx = TUT_STEPS[tutStep];
    const angle = (idx / n) * 2 * Math.PI - Math.PI / 2;
    return { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) };
  })() : null;

  // Find which emotion button is under a touch point
  const emojiAtPoint = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    let target: Element | null = el;
    while (target && target !== containerRef.current) {
      const v = target.getAttribute("data-emoji");
      if (v) return v;
      target = target.parentElement;
    }
    return null;
  };

  // Wire up touch tracking; cancel tutorial on first touch
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e: TouchEvent) => {
      stopTutorial();
      const t = e.touches[0];
      setHovered(emojiAtPoint(t.clientX, t.clientY) ?? "");
    };
    const onEnd = () => {
      setHovered((prev) => {
        if (prev) onSelect(prev);
        return "";
      });
    };
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    return () => {
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
  }, [onSelect, stopTutorial]);

  return (
    <div ref={containerRef} className="relative mx-auto flex-shrink-0" style={{ width: size, height: size }}>
      {/* Ring guide */}
      <div
        className="absolute rounded-full border border-gray-100"
        style={{
          width: radius * 2 + 36,
          height: radius * 2 + 36,
          left: center - radius - 18,
          top: center - radius - 18,
        }}
      />
      {/* Animated tutorial touch dot */}
      {tutPos && (
        <div
          className="absolute z-20 pointer-events-none -translate-x-1/2 -translate-y-1/2"
          style={{ left: tutPos.x, top: tutPos.y, transition: "left 0.28s ease, top 0.28s ease" }}
        >
          <div className="w-8 h-8 rounded-full bg-indigo-400/30 ring-2 ring-indigo-400/60 animate-ping" />
        </div>
      )}
      {/* Center label */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-center px-4">
          {displayEmotion ? (
            <>
              <div className={`text-3xl leading-none transition-all duration-150 ${isPreview ? "scale-125" : ""}`}>
                {displayEmotion.emoji}
              </div>
              <div className={`text-xs font-semibold mt-1 transition-colors ${isPreview ? "text-gray-600" : "text-gray-700"}`}>
                {displayEmotion.label}
              </div>
            </>
          ) : (
            <div className="text-[10px] text-gray-300 leading-tight text-center">slide to<br />explore</div>
          )}
        </div>
      </div>
      {/* Emotion buttons */}
      {WHEEL_EMOTIONS.map((emotion, i) => {
        const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
        const x = center + radius * Math.cos(angle);
        const y = center + radius * Math.sin(angle);
        const isSelected = selected === emotion.emoji;
        const isHovered = hovered === emotion.emoji;
        return (
          <button
            key={emotion.emoji}
            data-emoji={emotion.emoji}
            onClick={() => { stopTutorial(); onSelect(emotion.emoji); }}
            onMouseEnter={() => { stopTutorial(); setHovered(emotion.emoji); }}
            onMouseLeave={() => setHovered("")}
            className={`absolute flex items-center justify-center rounded-full transition-all duration-100 -translate-x-1/2 -translate-y-1/2 ${
              isSelected
                ? "w-11 h-11 text-2xl bg-indigo-100 ring-2 ring-indigo-400 z-10"
                : isHovered
                ? "w-11 h-11 text-2xl bg-gray-100 z-10"
                : "w-9 h-9 text-xl"
            }`}
            style={{ left: x, top: y }}
          >
            {emotion.emoji}
          </button>
        );
      })}
    </div>
  );
}

function MoodModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (emoji: string, text: string) => void;
  onClose: () => void;
}) {
  const [selectedEmoji, setSelectedEmoji] = useState("");
  const [text, setText] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [customEmotion, setCustomEmotion] = useState("");
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const effectiveEmoji = customMode ? customEmotion.trim() : selectedEmoji;

  function handleWheelSelect(emoji: string) {
    setSelectedEmoji(emoji);
    setCustomMode(false);
    setCustomEmotion("");
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full sm:max-w-sm rounded-t-3xl sm:rounded-2xl bg-white shadow-xl pt-5 pb-8 px-5 sm:pb-5 space-y-4">
        {/* Drag handle — mobile only */}
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto sm:hidden" />
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🧠</span>
            <h2 className="text-base font-semibold text-gray-900">Emotional Check-in</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">How are you feeling?</p>
        <EmotionWheel selected={customMode ? "" : selectedEmoji} onSelect={handleWheelSelect} />

        {customMode ? (
          <div className="space-y-1">
            <input
              type="text"
              value={customEmotion}
              onChange={(e) => setCustomEmotion(e.target.value)}
              placeholder="describe the feeling in your own words…"
              className="w-full border border-indigo-300 rounded-xl px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              autoFocus
            />
            <p className="text-[11px] text-gray-400 text-center">or tap the wheel to pick an emotion</p>
          </div>
        ) : (
          <button
            onClick={() => { setCustomMode(true); setSelectedEmoji(""); }}
            className="text-xs text-gray-400 hover:text-indigo-500 underline w-full text-center"
          >
            not in the wheel?
          </button>
        )}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's going on? (optional)"
          rows={2}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />

        <button
          onClick={() => effectiveEmoji && onSubmit(effectiveEmoji, text)}
          disabled={!effectiveEmoji}
          className="w-full bg-indigo-600 text-white rounded-xl py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
        >
          Log check-in
        </button>
      </div>
    </div>
  );
}

function GoalCard({
  goal,
  onCheckIn,
  onUndo,
  onEdit,
  onDelete,
  loading,
}: {
  goal: GoalStatus;
  onCheckIn: (id: string) => void;
  onUndo: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  loading: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const doneCard = goal.isDone;
  const doneCircle = goal.isDone || (
    goal.frequency === "weekly" && goal.targetCount > 1 && goal.todayCount >= 1
  );
  const label = goal.frequency === "daily" ? "today" : "this week";

  return (
    <div
      className={`rounded-2xl border p-5 transition-all duration-300 ${
        doneCard
          ? "bg-green-50 border-green-200"
          : "bg-white border-gray-200 shadow-sm"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">{goal.emoji}</span>
            <h2 className="text-lg font-semibold text-gray-900 truncate">
              {goal.name}
            </h2>
          </div>
          <p className="text-sm text-gray-500 mb-3">
            {goal.targetCount}x {goal.frequency} &middot; {formatPeriod(goal.frequency)}
          </p>
          <StreakBadge streak={goal.streak} />
        </div>

        <div className="flex-shrink-0">
          {doneCircle ? (
            <div className="flex flex-col items-end gap-2">
              <div className="w-12 h-12 rounded-full bg-green-500 flex items-center justify-center shadow-md">
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex items-center gap-2">
                {goal.type === "mood" ? (
                  <button
                    onClick={() => onCheckIn(goal.id)}
                    disabled={loading}
                    className="text-xs text-indigo-500 hover:text-indigo-700 underline"
                  >
                    log another
                  </button>
                ) : (
                  <>
                    {goal.frequency === "daily" && goal.targetCount > 1 && (
                      <button
                        onClick={() => onCheckIn(goal.id)}
                        disabled={loading}
                        className="text-xs text-green-600 hover:text-green-800 underline"
                      >
                        +extra
                      </button>
                    )}
                    <button
                      onClick={() => onUndo(goal.id)}
                      disabled={loading}
                      className="text-xs text-gray-400 hover:text-gray-600 underline"
                    >
                      undo
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={() => onCheckIn(goal.id)}
              disabled={loading}
              className="w-12 h-12 rounded-full border-2 border-dashed border-gray-300 hover:border-green-400 hover:bg-green-50 transition-all duration-200 flex items-center justify-center group disabled:opacity-50"
            >
              <svg
                className="w-5 h-5 text-gray-300 group-hover:text-green-500 transition-colors"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {goal.targetCount > 1 && (
        <div className="mt-3">
          <div className="flex gap-1">
            {Array.from({ length: goal.targetCount }).map((_, i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  i < goal.completedThisPeriod ? "bg-green-500" : "bg-gray-200"
                }`}
              />
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {goal.completedThisPeriod}/{goal.targetCount} {label}
          </p>
        </div>
      )}

      <div className="flex justify-end gap-3 mt-3 pt-2 border-t border-gray-100">
        {confirmDelete ? (
          <>
            <span className="text-xs text-gray-500">Delete this habit?</span>
            <button
              onClick={() => onDelete(goal.id)}
              className="text-xs text-red-500 hover:text-red-700 font-medium underline"
            >
              yes, delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs text-gray-400 hover:text-gray-600 underline"
            >
              cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => onEdit(goal.id)}
              className="text-xs text-gray-400 hover:text-gray-600 underline"
            >
              edit
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs text-gray-400 hover:text-red-500 underline"
            >
              delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  const [goals, setGoals] = useState<GoalStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reflectionTarget, setReflectionTarget] = useState<GoalStatus | null>(null);
  const [moodModalOpen, setMoodModalOpen] = useState(false);

  const fetchGoals = useCallback(async () => {
    try {
      const res = await fetch("/api/goals");
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setGoals(data);
    } catch {
      setError("Couldn't load goals. Is the server running?");
    } finally {
      setInitialLoad(false);
    }
  }, []);

  useEffect(() => {
    fetchGoals();
  }, [fetchGoals]);

  // Refresh at midnight PST
  useEffect(() => {
    function msUntilMidnightPST(): number {
      const now = new Date();
      const pstNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      const msSinceMidnight =
        pstNow.getHours() * 3600000 +
        pstNow.getMinutes() * 60000 +
        pstNow.getSeconds() * 1000 +
        pstNow.getMilliseconds();
      return 86400000 - msSinceMidnight;
    }

    let timeout: ReturnType<typeof setTimeout>;
    function scheduleRefresh() {
      timeout = setTimeout(() => {
        fetchGoals();
        scheduleRefresh();
      }, msUntilMidnightPST());
    }
    scheduleRefresh();
    return () => clearTimeout(timeout);
  }, [fetchGoals]);

  const doCheckIn = async (goalId: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId }),
      });
      if (!res.ok) throw new Error("Check-in failed");
      await fetchGoals();
    } catch {
      setError("Check-in failed. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleCheckIn = (goalId: string) => {
    const goal = goals.find((g) => g.id === goalId);
    if (goal?.type === "mood") {
      setMoodModalOpen(true);
      return;
    }
    if (goal?.lastPeriodMissed && goal.completedThisPeriod === 0) {
      setReflectionTarget(goal);
    } else {
      doCheckIn(goalId);
    }
  };

  const handleMoodSubmit = async (emoji: string, text: string) => {
    setMoodModalOpen(false);
    setLoading(true);
    try {
      await fetch("/api/mood", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji, text }),
      });
      await fetchGoals();
    } catch {
      setError("Failed to log check-in. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleReflectionSubmit = async (text: string) => {
    if (!reflectionTarget) return;
    const goalId = reflectionTarget.id;
    setReflectionTarget(null);
    if (text.trim()) {
      await fetch("/api/reflections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId, text }),
      });
    }
    await doCheckIn(goalId);
  };

  const handleReflectionSkip = async () => {
    if (!reflectionTarget) return;
    const goalId = reflectionTarget.id;
    setReflectionTarget(null);
    await doCheckIn(goalId);
  };

  const handleUndo = async (goalId: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/checkins", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId }),
      });
      if (!res.ok) throw new Error("Undo failed");
      await fetchGoals();
    } catch {
      setError("Undo failed. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveHabit = async (goal: Goal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(goal),
      });
      if (!res.ok) throw new Error("Save failed");
      setAddingNew(false);
      setEditingId(null);
      await fetchGoals();
    } catch {
      setError("Couldn't save habit. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteHabit = async (goalId: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/goals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: goalId }),
      });
      if (!res.ok) throw new Error("Delete failed");
      await fetchGoals();
    } catch {
      setError("Couldn't delete habit. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const allDone = goals.length > 0 && goals.every((g) => g.isDone);

  const updatedLabel = new Date(versionData.updatedAt + "T12:00:00").toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  });

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Hey Alan 👋</h1>
          <p className="text-gray-500 mt-1">
            {getTodayPST().toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
        <div className="text-right mt-1">
          <p className="text-xs font-semibold text-gray-400">v{versionData.version}</p>
          <p className="text-[11px] text-gray-300">updated {updatedLabel}</p>
        </div>
      </div>

      {/* All done banner */}
      {allDone && (
        <div className="mb-6 rounded-2xl bg-green-500 text-white p-4 text-center shadow-md">
          <p className="text-xl font-bold">All done for today! 🎉</p>
          <p className="text-green-100 text-sm mt-0.5">Keep it up.</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
        </div>
      )}

      {/* Goals */}
      {initialLoad ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="rounded-2xl bg-white border border-gray-200 p-5 h-28 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {[...goals].sort((a, b) => {
            const handled = (g: GoalStatus) => g.isDone || (g.frequency === "weekly" && g.targetCount > 1 && g.todayCount >= 1);
            return Number(handled(a)) - Number(handled(b));
          }).map((goal) =>
            editingId === goal.id ? (
              <HabitForm
                key={goal.id}
                initial={goal}
                onSave={handleSaveHabit}
                onCancel={() => setEditingId(null)}
                loading={loading}
              />
            ) : (
              <GoalCard
                key={goal.id}
                goal={goal}
                onCheckIn={handleCheckIn}
                onUndo={handleUndo}
                onEdit={setEditingId}
                onDelete={handleDeleteHabit}
                loading={loading}
              />
            )
          )}

          {addingNew ? (
            <HabitForm
              onSave={handleSaveHabit}
              onCancel={() => setAddingNew(false)}
              loading={loading}
            />
          ) : (
            <button
              onClick={() => setAddingNew(true)}
              className="w-full rounded-2xl border-2 border-dashed border-gray-200 p-4 text-sm text-gray-400 hover:border-gray-300 hover:text-gray-600 transition-colors"
            >
              + Add habit
            </button>
          )}
        </div>
      )}

      {/* Reflection modal */}
      {reflectionTarget && (
        <ReflectionModal
          goal={reflectionTarget}
          onSubmit={handleReflectionSubmit}
          onSkip={handleReflectionSkip}
          onClose={() => setReflectionTarget(null)}
        />
      )}

      {/* Mood modal */}
      {moodModalOpen && (
        <MoodModal
          onSubmit={handleMoodSubmit}
          onClose={() => setMoodModalOpen(false)}
        />
      )}

    </main>
  );
}
