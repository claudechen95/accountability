export interface Goal {
  id: string;
  name: string;
  emoji: string;
  frequency: "daily" | "weekly";
  targetCount: number; // how many times per period
  nudgeDays?: number[]; // 0=Sun…6=Sat; weekly goals only
  nudgeTime?: string;  // "HH:MM" PST 24hr, default "21:00"
  nudgeEnabled?: boolean; // daily goals only; opt out of the daily pending-nudge modal, default true
  nudgeNumber?: number; // stable per-user 1..N id shown/used in text nudges, e.g. "reply 2"; renumbered compactly whenever a goal is added or removed
  type?: "mood";
  order?: number;
  streakOffset?: number; // legacy streak days preserved across frequency changes

  // --- Graduation ---
  // A graduated habit is one the user has decided is automatic. The app stops tracking it:
  // no check-ins, no nudges, no reflection prompts, no streak recomputation. It moves to the
  // trophy shelf at the top of the home screen and stays there until manually un-graduated.
  graduatedAt?: string;   // YYYY-MM-DD it was graduated; presence of this is what "graduated" means
  graduatedRun?: number;  // the run it had earned, frozen at graduation: days (daily) or weeks (weekly)
  // "not yet" on a graduation suggestion. Held until this date so a habit the user wants to
  // keep working on doesn't re-ask every single day.
  graduationSnoozedUntil?: string; // YYYY-MM-DD
}

// One target a habit has had, appended whenever the target changes. The record is the target as
// of `date` - not the change - so a chart of them is a step line, and the direction of a change
// is just this entry compared with the one before it.
//
// This is a log, not a scoring input: getHistory, the streaks and graduation all still judge
// every past period against the habit's *current* target. Nothing reads target history to decide
// whether a day or a week was met.
export interface TargetChange {
  date: string;                     // YYYY-MM-DD (PST) the target took effect
  at: number;                       // epoch ms, so several edits on one day still order
  frequency: "daily" | "weekly";
  targetCount: number;
  // Where the record came from. "created" is a real start date, so a chart can begin the line
  // there; "backfilled" is the target a habit already had when we first noticed it change, whose
  // true start date we never recorded, so the line before it is open-ended.
  origin: "created" | "edited" | "backfilled";
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
  // The meeting itself has these four sections, so the note stores them as four fields rather
  // than as one prose blob the reader has to parse. One string per bullet.
  wentWell: string[];
  didntGoWell: string[];
  actionItems: string[];
  // Retired free-form fields, optional so notes written before the sections existed still read
  // back and still render. Nothing writes them now.
  notes?: string;
  changes?: string[];
  updatedAt: number;
}

// Why we're asking for a reflection before the next check-in. Carries the numbers behind the
// call so the prompt can say what actually went wrong instead of a generic "you missed this".
export type ReflectionReason =
  // Daily goal: every recent missed day it hasn't been asked about yet, oldest first. A run of
  // misses is one prompt covering all of them, not one prompt for the last day of the run.
  | { reason: "missed-day"; dates: string[] }
  // Weekly goals. `date` is the one day the prompt is actually about - the most recent day of
  // the week in question that was expected and didn't happen - so a weekly habit asks the same
  // concrete question a daily one does instead of handing back a week's arithmetic. It's null
  // only when no such day exists yet (a week that's fallen behind before any day has closed),
  // which is the one case that still has to fall back to the counts.
  | { reason: "week-behind"; date: string | null; completed: number; target: number; daysLeft: number }
  | { reason: "week-missed"; date: string | null; completed: number; target: number };

export type ReflectionPrompt = ReflectionReason & {
  // Whether the reflection has to be written before the check-in goes through. Required once
  // the period is already lost (nothing left to salvage, so the only useful move is to name
  // what happened); optional while the target is still reachable and the user is, right now,
  // doing the thing we wanted.
  required: boolean;
};

/**
 * Everything getPendingNudges needs to judge a habit, and nothing else. The ladder asks only
 * "how much of this period is done, and was anything logged on the day itself" - not for a
 * streak, a reflection prompt or a graduation offer, all of which cost Redis reads a cron tick
 * has no use for. Splitting it out also lets the nudge day be a date other than today, which
 * GoalStatus (always "now") can't express.
 */
export interface NudgeCandidate extends Goal {
  completedThisPeriod: number;
  /** Check-ins on the nudge day itself, which is what stops a weekly habit nudging twice. */
  todayCount: number;
}

export interface GoalStatus extends NudgeCandidate {
  isDone: boolean;
  streak: number;
  reflection: ReflectionPrompt | null;
  // The run is long enough to offer graduation and the user hasn't waved the offer off yet.
  // Always false for an already-graduated habit - there's nothing left to suggest.
  canGraduate: boolean;
}
