export interface Goal {
  id: string;
  name: string;
  emoji: string;
  frequency: "daily" | "weekly";
  targetCount: number; // how many times per period
  nudgeDays?: number[]; // 0=Sun…6=Sat; weekly goals only (daily goals always nudge)
  nudgeTime?: string;  // "HH:MM" PST 24hr, default "21:00"
  type?: "mood";
}

export interface MoodEntry {
  id: string;
  timestamp: number;
  date: string; // YYYY-MM-DD
  emoji: string;
  text: string;
}

export interface CheckInRecord {
  goalId: string;
  timestamp: number;
  date: string; // YYYY-MM-DD
  week: string; // YYYY-WXX
}

export interface WeeklyNote {
  week: string;       // "2026-W13"
  weekLabel: string;  // "Week of Mar 24"
  headline: string;
  notes: string;
  changes: string[];
  updatedAt: number;
}

export interface GoalStatus extends Goal {
  completedThisPeriod: number;
  isDone: boolean;
  streak: number;
  todayCount: number;
  lastPeriodMissed: boolean;
}
