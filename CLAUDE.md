# Alan's Accountability App — Claude Code Context

Personal habit tracker for Alan. Next.js 14 app router, Upstash Redis (KV), deployed on Vercel. No auth — single-user.

## Stack
- **Frontend:** `app/page.tsx` (single-page client component, all goal UI lives here)
- **API routes:** `app/api/` — goals, checkins, history, notes, reflections, mood, settings, remind
- **Data layer:** `lib/kv.ts` — all Redis reads/writes. Import from here, never call Redis directly elsewhere.
- **Types:** `lib/types.ts` — `Goal`, `GoalStatus`, `WeeklyNote`, `CheckInRecord`, `MoodEntry`
- **Timezone:** Everything PST/PDT (`America/Los_Angeles`). Date strings are `YYYY-MM-DD`.

## Data model
Goals are stored as a JSON array at Redis key `goals`. No separate goal IDs table.

Check-ins are stored per-day: `checkin:{goalId}:{YYYY-MM-DD}` → count. Weekly goals are tracked daily and aggregated — there are NO week-keyed checkin records anymore.

Reflections: `reflection:{goalId}:{YYYY-MM-DD}` → `{ text, savedAt }`. Always date-keyed (not week-keyed), for both daily and weekly goals.

Mood entries: `mood:{YYYY-MM-DD}` → list of `MoodEntry` JSON strings. Also increments `checkin:emotional-checkin:{date}`.

Weekly notes: `note:{YYYY-WXX}` → `WeeklyNote`. Seeded via `seedInitialWeeklyNote()`, `seedWeeklyNoteW22()`, `seedWeeklyNoteW23()` etc., all called in the GET handler of `app/api/notes/route.ts`.

## Goal schema
```ts
interface Goal {
  id: string;
  name: string;
  emoji: string;
  frequency: "daily" | "weekly";
  targetCount: number;
  type?: "mood";       // only on emotional-checkin
  order?: number;      // drag-to-reorder position
  nudgeDays?: number[]; // 0=Sun…6=Sat
  nudgeTime?: string;  // "HH:MM" PST
}
```

## Key behaviors
- **Goal ordering:** Drag-and-drop via `@dnd-kit`. Done goals always sink to bottom. Order persisted via `PATCH /api/goals` with `{ orderedIds: string[] }`.
- **Reflection prompt:** Triggers when `lastPeriodMissed && completedThisPeriod === 0`. `lastPeriodMissed` = yesterday had 0 check-ins, for ALL goal types (not weekly-boundary based).
- **Emotional Check-in** (`id: "emotional-checkin"`, `type: "mood"`): Opens mood emoji picker. "Log another" instead of "undo" when done. No position pin — user controls via drag.
- **Backfill:** Click a missed (gray/amber) cell in the history grid to log it for that date. `POST /api/checkins` accepts `{ goalId, date }`.
- **Weekly streak for weekly goals:** Counted in weeks, not days. `getWeeklyStreak()` walks back 52 weeks.

## Migrations (run on every `getGoals()` call)
Add new ones at the bottom of the migration block in `getGoals()`, before `if (changed) await kv.set("goals", goals)`:
- Sleep goal added if missing
- `emotional-checkin` goal added if missing
- Eye ointment: `targetCount` bumped from 5 → 6 if still at 5 (June 2026)

## Adding a weekly note
1. Add `export async function seedWeeklyNoteWXX()` to `lib/kv.ts` (copy pattern from `seedWeeklyNoteW23`)
2. Import and call it in `app/api/notes/route.ts` GET handler alongside the other seeds

## Dev
```bash
npm run dev        # localhost:3000
npm run deploy     # Vercel deploy via scripts/deploy.sh
```
Env vars needed: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (in `.env.local`).

## Goals currently tracked (as of June 2026)
Gym-split: HIIT (1x/week), Resistance training (1x/week) · Piano Session (3x/week) · Eye ointment (6x/week) · Stretch (2x/week) · Protein drink (1x/daily) · 7+ hr sleep · Salad · Emotional Check-in (mood/daily)
