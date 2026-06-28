import { Redis } from "@upstash/redis";

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  cache: "no-store",
});
import type { Goal, CheckInRecord, WeeklyNote, MoodEntry } from "./types";

// Normalize the ?user= param: "alan" and empty both map to undefined (un-prefixed namespace).
// Call this in every API route when reading the user query param.
export function resolveUser(param: string | null | undefined): string | undefined {
  if (!param || param === "alan") return undefined;
  return param;
}

// Namespace Redis keys by user. No userId → Alan's existing un-prefixed keys (backward compat).
function k(userId: string | undefined, key: string): string {
  return userId ? `${userId}:${key}` : key;
}

// --- Default goals seeded on first run ---
const DEFAULT_GOALS: Goal[] = [
  {
    id: "gym",
    name: "Gym session",
    emoji: "🏋️",
    frequency: "weekly",
    targetCount: 1,
  },
  {
    id: "protein",
    name: "Protein drink",
    emoji: "🥤",
    frequency: "weekly",
    targetCount: 5,
  },
  {
    id: "sleep",
    name: "7+ hr sleep",
    emoji: "😴",
    frequency: "daily",
    targetCount: 1,
  },
];

// --- Settings ---
export async function getRemindHour(userId?: string): Promise<number> {
  const val = await kv.get<number>(k(userId, "settings:remindHour"));
  return val ?? 20; // default 8 PM PST
}

export async function setRemindHour(hour: number, userId?: string): Promise<void> {
  await kv.set(k(userId, "settings:remindHour"), hour);
}

// --- Period helpers ---
export function getTodayDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date()); // YYYY-MM-DD in PST/PDT
}

export function getWeekKey(date?: string): string {
  const d = date ? new Date(date + "T12:00:00") : new Date();
  const pstDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(d);
  const local = new Date(pstDate + "T12:00:00");
  // ISO week number (Math.floor to avoid fractional days from T12:00:00)
  const jan4 = new Date(local.getFullYear(), 0, 4);
  const daysDiff = Math.floor((local.getTime() - jan4.getTime()) / 86400000);
  const week = Math.ceil((daysDiff + jan4.getDay() + 1) / 7);
  return `${local.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function getPeriodKey(frequency: "daily" | "weekly"): string {
  return frequency === "daily" ? getTodayDate() : getWeekKey();
}

// Returns the 7 YYYY-MM-DD dates (Mon–Sun) for the week containing dateStr
function getWeekDatesForDate(dateStr: string): string[] {
  const [y, m, d] = dateStr.split("-").map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12));
  const dayOfWeek = (ref.getUTCDay() + 6) % 7; // 0=Mon
  ref.setUTCDate(ref.getUTCDate() - dayOfWeek); // rewind to Monday
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(ref);
    day.setUTCDate(ref.getUTCDate() + i);
    return [
      day.getUTCFullYear(),
      String(day.getUTCMonth() + 1).padStart(2, "0"),
      String(day.getUTCDate()).padStart(2, "0"),
    ].join("-");
  });
}

// Count how many days in the given week had ≥1 check-in.
// Falls back to the legacy weekly key (checkin:{id}:{YYYY-WXX}) for data recorded before the
// switch to daily storage, counting it as 1 day if the weekly key has ≥1 check-in.
async function getWeeklyDaysCompleted(goalId: string, weekDates: string[], userId?: string): Promise<number> {
  const counts = await kv.mget<number[]>(...weekDates.map((d) => k(userId, `checkin:${goalId}:${d}`)));
  const fromDaily = counts.filter((c) => (c ?? 0) >= 1).length;
  if (fromDaily > 0) return fromDaily;

  // Legacy fallback: weekly key stored before per-day tracking
  const legacyKey = k(userId, `checkin:${goalId}:${getWeekKey(weekDates[0])}`);
  const legacy = await kv.get<number>(legacyKey);
  return (legacy ?? 0) >= 1 ? 1 : 0;
}

// Unified: completed count for the current period (days for weekly goals, raw count for daily)
export async function getCompletedThisPeriod(goal: Goal, userId?: string): Promise<number> {
  if (goal.frequency === "daily") {
    return getCheckInsForPeriod(goal.id, getTodayDate(), userId);
  }
  return getWeeklyDaysCompleted(goal.id, getWeekDatesForDate(getTodayDate()), userId);
}

// --- Goals ---
export async function getGoals(userId?: string): Promise<Goal[]> {
  let goals = await kv.get<Goal[]>(k(userId, "goals"));
  if (!goals) {
    // Only seed Alan's default goals for his namespace; other users start empty
    if (!userId) {
      await kv.set("goals", DEFAULT_GOALS);
      return DEFAULT_GOALS;
    }
    return [];
  }

  // Migrations — Alan's namespace only
  if (!userId) {
    let changed = false;

    if (!goals.find((g) => g.id === "sleep")) {
      goals.push({ id: "sleep", name: "7+ hr sleep", emoji: "😴", frequency: "daily", targetCount: 1 });
      changed = true;
    }

    if (!goals.find((g) => g.id === "emotional-checkin")) {
      goals.push({
        id: "emotional-checkin",
        name: "Emotional Check-in",
        emoji: "🧠",
        frequency: "daily",
        targetCount: 1,
        type: "mood",
      });
      changed = true;
    }

    // Eye ointment bumped from 5x to 6x/week (June 2026)
    const eyeGoal = goals.find((g) => g.name === "Eye ointment" && g.targetCount === 5);
    if (eyeGoal) {
      eyeGoal.targetCount = 6;
      changed = true;
    }

    // Salad upgraded from 6x/week to daily (June 2026); preserve weekly streak as offset
    const saladGoal = goals.find((g) => g.id === "salad" && g.frequency === "weekly");
    if (saladGoal) {
      const oldWeeklyStreak = await getWeeklyStreak(saladGoal, userId);
      saladGoal.streakOffset = oldWeeklyStreak * 7;
      saladGoal.frequency = "daily";
      saladGoal.targetCount = 1;
      changed = true;
    }

    if (changed) await kv.set(k(userId, "goals"), goals);
  }

  return goals;
}

export async function saveGoals(goals: Goal[], userId?: string): Promise<void> {
  await kv.set(k(userId, "goals"), goals);
}

// --- Check-in records (individual events with timestamps) ---
export async function getCheckInRecords(goalId: string, limit = 200, userId?: string): Promise<CheckInRecord[]> {
  const raw = await kv.lrange<CheckInRecord>(k(userId, `history:${goalId}`), 0, limit - 1);
  return raw.sort((a, b) => b.timestamp - a.timestamp);
}

// --- Check-ins ---
export async function getCheckInsForPeriod(
  goalId: string,
  period: string,
  userId?: string
): Promise<number> {
  const count = await kv.get<number>(k(userId, `checkin:${goalId}:${period}`));
  return count ?? 0;
}

export async function addCheckIn(goalId: string, date?: string, userId?: string): Promise<{ count: number }> {
  const goals = await getGoals(userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error("Goal not found");

  const targetDate = date || getTodayDate();
  const newCount = await kv.incr(k(userId, `checkin:${goalId}:${targetDate}`));

  const record: CheckInRecord = {
    goalId,
    timestamp: Date.now(),
    date: targetDate,
    week: getWeekKey(targetDate),
  };
  await kv.lpush(k(userId, `history:${goalId}`), JSON.stringify(record));

  return { count: newCount };
}

export async function undoCheckIn(goalId: string, userId?: string): Promise<{ count: number }> {
  const goals = await getGoals(userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error("Goal not found");

  const today = getTodayDate();
  const key = k(userId, `checkin:${goalId}:${today}`);
  const current = (await kv.get<number>(key)) ?? 0;
  if (current <= 0) return { count: 0 };

  const newCount = await kv.decr(key);
  return { count: Math.max(0, newCount) };
}

// --- History ---
export async function getHistory(
  goal: Goal,
  periods: number,
  userId?: string
): Promise<{ period: string; count: number; done: boolean }[]> {
  const todayPST = getTodayDate();
  const [ty, tm, td] = todayPST.split("-").map(Number);
  const labels: string[] = [];
  for (let i = periods - 1; i >= 0; i--) {
    const utcDate = new Date(Date.UTC(ty, tm - 1, td - i));
    labels.push([
      utcDate.getUTCFullYear(),
      String(utcDate.getUTCMonth() + 1).padStart(2, "0"),
      String(utcDate.getUTCDate()).padStart(2, "0"),
    ].join("-"));
  }

  const keys = labels.map((label) => k(userId, `checkin:${goal.id}:${label}`));
  const counts = await kv.mget<number[]>(...keys);
  return labels.map((period, i) => {
    const count = counts[i] ?? 0;
    const done = goal.frequency === "daily" ? count >= goal.targetCount : count >= 1;
    return { period, count, done };
  });
}

// --- Streak calculation ---
export async function getStreak(goal: Goal, userId?: string): Promise<number> {
  if (goal.frequency === "daily") {
    return getDailyStreak(goal, userId);
  }
  return getWeeklyStreak(goal, userId);
}

async function getDailyStreak(goal: Goal, userId?: string): Promise<number> {
  let streak = 0;
  const today = new Date();

  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
    const count = await kv.get<number>(k(userId, `checkin:${goal.id}:${dateKey}`));
    if ((count ?? 0) >= goal.targetCount) {
      streak++;
    } else {
      // Don't break on today if not yet checked in
      if (i > 0) break;
    }
  }
  // Add any streak days preserved from a prior frequency change
  if (streak > 0 && goal.streakOffset) {
    streak += goal.streakOffset;
  }
  return streak;
}

async function getWeeklyStreak(goal: Goal, userId?: string): Promise<number> {
  let streak = 0;
  const todayStr = getTodayDate();

  for (let i = 0; i < 52; i++) {
    const [y, m, d] = todayStr.split("-").map(Number);
    const ref = new Date(Date.UTC(y, m - 1, d - i * 7, 12));
    const refStr = [
      ref.getUTCFullYear(),
      String(ref.getUTCMonth() + 1).padStart(2, "0"),
      String(ref.getUTCDate()).padStart(2, "0"),
    ].join("-");
    const daysCompleted = await getWeeklyDaysCompleted(goal.id, getWeekDatesForDate(refStr), userId);
    if (daysCompleted >= goal.targetCount) {
      streak++;
    } else {
      if (i > 0) break;
    }
  }
  return streak;
}

// --- Missed period detection ---

// Always returns yesterday's date regardless of goal frequency.
// Reflection prompts are triggered based on missing yesterday, not missing a whole week.
function getLastPeriodDateStr(): string {
  const today = getTodayDate();
  const [y, m, d] = today.split("-").map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d - 1, 12));
  return [
    ref.getUTCFullYear(),
    String(ref.getUTCMonth() + 1).padStart(2, "0"),
    String(ref.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function getLastPeriodKey(_goal: Goal): string {
  return getLastPeriodDateStr();
}

export async function getLastPeriodMissed(goal: Goal, userId?: string): Promise<boolean> {
  const hasHistory = (await kv.llen(k(userId, `history:${goal.id}`))) > 0;
  if (!hasHistory) return false;

  const count = await getCheckInsForPeriod(goal.id, getLastPeriodDateStr(), userId);
  return count === 0;
}

export async function getReflectionsForGoal(
  goalId: string,
  periodKeys: string[],
  userId?: string
): Promise<Record<string, string>> {
  if (periodKeys.length === 0) return {};
  const values = (await kv.mget(
    ...periodKeys.map((pk) => k(userId, `reflection:${goalId}:${pk}`))
  )) as ({ text: string; savedAt: number } | null)[];
  const result: Record<string, string> = {};
  periodKeys.forEach((pk, i) => {
    const val = values[i];
    if (val?.text) result[pk] = val.text;
  });
  return result;
}

// --- Reflections ---

export async function saveReflection(goalId: string, text: string, userId?: string): Promise<void> {
  const goals = await getGoals(userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return;
  const periodKey = getLastPeriodKey(goal);
  await kv.set(k(userId, `reflection:${goalId}:${periodKey}`), { text, savedAt: Date.now() });
}

// --- Weekly Notes ---

export function getCurrentWeekKey(): string {
  return getWeekKey();
}

export function getWeekLabel(weekKey?: string): string {
  // weekKey format: "2026-W13"
  const [year, weekStr] = (weekKey || getWeekKey()).split("-W");
  const week = parseInt(weekStr, 10);

  // Calculate the Monday of that week
  const jan4 = new Date(parseInt(year), 0, 4);
  const daysToMonday = (jan4.getDay() + 6) % 7;
  const firstMonday = new Date(jan4);
  firstMonday.setDate(jan4.getDate() - daysToMonday);

  const targetMonday = new Date(firstMonday);
  targetMonday.setDate(firstMonday.getDate() + (week - 1) * 7);

  const monthLabel = targetMonday.toLocaleDateString("en-US", { month: "short" });
  const dayLabel = targetMonday.getDate();

  return `Week of ${monthLabel} ${dayLabel}`;
}

export async function getWeeklyNote(weekKey: string, userId?: string): Promise<WeeklyNote | null> {
  const note = await kv.get<WeeklyNote>(k(userId, `note:${weekKey}`));
  return note;
}

export async function getAllWeeklyNotes(limit = 52, userId?: string): Promise<WeeklyNote[]> {
  const prefix = userId ? `${userId}:note:` : "note:";
  const keys = await kv.keys(`${prefix}*`);
  const notes: WeeklyNote[] = [];

  for (const key of keys.slice(0, limit)) {
    const note = await kv.get<WeeklyNote>(key);
    if (note) notes.push(note);
  }

  // Sort by week descending (newest first)
  return notes.sort((a, b) => b.week.localeCompare(a.week));
}

export async function saveWeeklyNote(note: Omit<WeeklyNote, "updatedAt">, userId?: string): Promise<void> {
  const fullNote: WeeklyNote = {
    ...note,
    updatedAt: Date.now(),
  };
  await kv.set(k(userId, `note:${note.week}`), fullNote);
}

export async function deleteWeeklyNote(weekKey: string, userId?: string): Promise<void> {
  await kv.del(k(userId, `note:${weekKey}`));
}

// --- Mood / Emotional Check-in ---

export async function addMoodEntry(emoji: string, text: string, userId?: string): Promise<void> {
  const today = getTodayDate();
  const entry: MoodEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    date: today,
    emoji,
    text,
  };
  await kv.rpush(k(userId, `mood:${today}`), JSON.stringify(entry));
  await kv.incr(k(userId, `checkin:emotional-checkin:${today}`));
  const historyRecord: CheckInRecord = {
    goalId: "emotional-checkin",
    timestamp: entry.timestamp,
    date: today,
    week: getWeekKey(today),
  };
  await kv.lpush(k(userId, `history:emotional-checkin`), JSON.stringify(historyRecord));
}

export async function getMoodEntries(date: string, userId?: string): Promise<MoodEntry[]> {
  const raw = await kv.lrange<string | MoodEntry>(k(userId, `mood:${date}`), 0, -1);
  return raw.map((e) => (typeof e === "string" ? JSON.parse(e) : e));
}

export async function deleteMoodEntry(date: string, id: string, userId?: string): Promise<void> {
  const raw = await kv.lrange<string | MoodEntry>(k(userId, `mood:${date}`), 0, -1);
  for (const item of raw) {
    const entry: MoodEntry = typeof item === "string" ? JSON.parse(item) : item;
    if (entry.id === id) {
      // lrem removes all list elements equal to this value
      await kv.lrem(k(userId, `mood:${date}`), 1, item);
      // Decrement the habit completion count for that day
      const key = k(userId, `checkin:emotional-checkin:${date}`);
      const current = (await kv.get<number>(key)) ?? 0;
      if (current > 0) await kv.decr(key);
      return;
    }
  }
}

export async function getAllMoodEntries(limit = 90, userId?: string): Promise<MoodEntry[]> {
  const prefix = userId ? `${userId}:mood:` : "mood:";
  const keys = await kv.keys(`${prefix}*`);
  if (keys.length === 0) return [];
  const sorted = keys
    .map((key) => key.replace(prefix, ""))
    .sort()
    .reverse()
    .slice(0, limit);
  const all: MoodEntry[] = [];
  for (const date of sorted) {
    const entries = await getMoodEntries(date, userId);
    all.push(...entries);
  }
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

export interface JournalEntry {
  id: string;
  timestamp: number;
  text: string;
}

export async function addJournalEntry(text: string, userId?: string): Promise<void> {
  const entry: JournalEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    text,
  };
  await kv.lpush(k(userId, "journal"), JSON.stringify(entry));
}

export async function getJournalEntries(limit = 100, userId?: string): Promise<JournalEntry[]> {
  const raw = await kv.lrange<string | JournalEntry>(k(userId, "journal"), 0, limit - 1);
  return raw.map((e) => (typeof e === "string" ? JSON.parse(e) : e));
}

export async function deleteJournalEntry(id: string, userId?: string): Promise<void> {
  const raw = await kv.lrange<string | JournalEntry>(k(userId, "journal"), 0, -1);
  for (const item of raw) {
    const entry: JournalEntry = typeof item === "string" ? JSON.parse(item) : item;
    if (entry.id === id) {
      await kv.lrem(k(userId, "journal"), 1, item);
      return;
    }
  }
}

// Seed initial note for March 23, 2026 week (W13)
export async function seedInitialWeeklyNote(): Promise<void> {
  const weekKey = "2026-W13";
  const existing = await getWeeklyNote(weekKey);
  if (existing) return;

  await saveWeeklyNote({
    week: weekKey,
    weekLabel: "Week of Mar 24",
    headline: "Setting the Foundation",
    notes: "Identified the biggest levers for discipline. Focus on sleep and nutrition as the foundation for everything else.",
    changes: [
      "🥗 Added: Macro nutrients tracking (daily)",
      "😴 Added: 7+ hr sleep tracking (daily) — biggest lever for discipline",
      "🥤 Adjusted: Protein intake changed from daily to 5x/week to lower burden",
      "✅ Reaffirmed: Lowering burden while maintaining progress IS progress",
    ],
  });
}

// Seed note for Jun 8, 2026 week (W24)
export async function seedWeeklyNoteW25(): Promise<void> {
  const weekKey = "2026-W25";
  const existing = await getWeeklyNote(weekKey);
  if (existing) return;

  await saveWeeklyNote({
    week: weekKey,
    weekLabel: "Week of Jun 15",
    headline: "Salad Goes Daily, Notification Fatigue & Emotional Check-in Rethink",
    notes: "Solid week overall with a few patterns worth fixing. Salad has been consistent for 5 straight weeks so we're upgrading it to a daily goal. The app incorrectly showed a 'missed yesterday' warning for a 6x weekly goal — a bug to fix. Stretch is still getting crammed into the weekend; the plan is to try one weekday session (Friday) to spread it out. Notification fatigue came up: nudging every day trains you to ignore it, so each habit's nudge days should be set intentionally. Emotional check-ins mostly logged as neutral because they happen at calm moments — new approach is to reflect on emotions felt throughout the day, even hours earlier, and log those.",
    changes: [
      "🥗 Updated: Salad goal upgraded from 6x/week to daily (5 weeks of strong consistency)",
      "🐛 Bug: Salad incorrectly shows 'missed yesterday' warning for a 6x/week goal — needs fix",
      "🐛 Bug: Reflection popup not appearing for Sleep, Stretch, or Emotional Check-in — needs investigation",
      "🔔 Insight: Nudging every day causes notification fatigue — review and set intentional nudge days per habit",
      "🧘 Plan: Add one weekday stretch session (Friday) instead of cramming both into the weekend",
      "💭 Insight: Log emotional check-ins based on emotions felt throughout the day, not just the current moment",
    ],
  });
}

export async function seedWeeklyNoteW24(): Promise<void> {
  const weekKey = "2026-W24";
  const existing = await getWeeklyNote(weekKey);
  if (existing) return;

  await saveWeeklyNote({
    week: weekKey,
    weekLabel: "Week of Jun 8",
    headline: "Habit Bundling, Sunday Crunch & Sleep Reflection Bug",
    notes: "Alan tends to push tasks to later in the day or to the weekend — this week it caught up with him when something came up Sunday and he lost the time he was counting on. The fix: set an alarm when you decide to do something later, not just a mental note. Also discussed habit bundling from Atomic Habits — pairing a new habit with an existing one (floss when you brush your teeth) lowers the activation energy. Sleep reflection entries are not showing in history; likely a bug to investigate.",
    changes: [
      "📖 Insight: Habit bundling — attach new habits to existing ones (e.g. floss right after brushing teeth)",
      "⏰ Insight: Don't just defer tasks mentally — set an alarm at the moment you decide to do it later",
      "⚠️ Bug: Reflections for 7+ hr sleep are not displaying in the history grid — needs investigation",
      "📅 Pattern: Alan waited until Sunday to complete weekly habits, but an unexpected event wiped out that buffer",
    ],
  });
}

// Seed note for Jun 1, 2026 week (W23)
export async function seedWeeklyNoteW23(): Promise<void> {
  const weekKey = "2026-W23";
  const existing = await getWeeklyNote(weekKey);
  if (existing) return;

  await saveWeeklyNote({
    week: weekKey,
    weekLabel: "Week of Jun 1",
    headline: "Reflection for Any Missed Day, Eye Ointment to 6x & Pinned Check-in",
    notes: "Three targeted improvements: fixed a bug where the reflection prompt for weekly goals only triggered at the start of a new week (now triggers whenever yesterday was missed, regardless of goal frequency). Bumped the eye ointment target from 5x to 6x per week. Pinned the Emotional Check-in habit to always appear first in the goal list.",
    changes: [
      "🐛 Fixed: Reflection prompt now triggers for any goal if you missed yesterday — no longer limited to weekly-goal week boundaries",
      "💧 Updated: Eye ointment raised from 5x to 6x per week",
      "📌 Added: Emotional Check-in pinned to always appear first in the habit list",
    ],
  });
}

// Seed note for May 25, 2026 week (W22)
export async function seedWeeklyNoteW22(): Promise<void> {
  const weekKey = "2026-W22";
  const existing = await getWeeklyNote(weekKey);
  if (existing) return;

  await saveWeeklyNote({
    week: weekKey,
    weekLabel: "Week of May 25",
    headline: "Reflection Display, Retroactive Logging & Emotional Check-in",
    notes: "Reviewed the history UX — reflections were being saved but the display needed to show them clearly on hover. Planned two new features: retroactive logging for days you forgot to track, and a new Emotional Check-in habit.",
    changes: [
      "🐛 Fixed: Missed-day reflection now visible on hover in the history grid (amber cells)",
      "📅 Added: Retroactive logging — click a missed day in history to mark it as done",
      "💭 Added: Emotional Check-in habit — pick an emoji (good/bad), write a note, log multiple times/day",
    ],
  });
}
