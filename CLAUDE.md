# Alan & Rochisha's Accountability App — Claude Code Context

Personal habit tracker. Next.js 14 app router, Upstash Redis (KV), deployed on Vercel. No auth — multi-user by URL path, fully isolated per user.

## Stack
- **Frontend:** `app/page.tsx` (landing page, lists users) + `app/[user]/page.tsx` (per-user tracker)
- **API routes:** `app/api/` — goals, checkins, history, notes, reflections, mood, settings, vacation, users, nudge/dispatch, nudge/inbound
- **Data layer:** `lib/kv.ts` — all Redis reads/writes. Import from here, never call Redis directly elsewhere.
- **Types:** `lib/types.ts` — `Goal`, `GoalStatus`, `WeeklyNote`, `CheckInRecord`, `MoodEntry`
- **Timezone:** Everything PST/PDT (`America/Los_Angeles`). Date strings are `YYYY-MM-DD`.

## Multi-user architecture

Users are identified by URL path (`/alan`, `/rochisha`). All API routes read `?user=` and pass it through the data layer.

**`resolveUser(param)`** in `lib/kv.ts` normalizes the param: `"alan"` and `null`/`""` both map to `undefined` (backward compat — Alan's data has no prefix). Any other value is returned as-is.

**`k(userId, key)`** namespaces Redis keys: `userId ? \`${userId}:${key}\` : key`. So Alan's `goals` key stays `goals`; Rochisha's becomes `rochisha:goals`.

All data is fully isolated: goals, checkins, history, reflections, mood, weekly notes, journal, settings, notification dedup flags.

### Adding a new user

**Option A — Admin UI (no terminal needed):**
Go to `/admin`, fill in user ID + display name, click Add. Topics are generated and stored in Redis automatically. The user appears on the landing page immediately. No deployment, no env vars.

**Option B — Script (from terminal):**
```bash
node scripts/add-user.mjs <id> "<Label>"
# Example:
node scripts/add-user.mjs alice "Alice"
```
Writes directly to Redis. Prints the ntfy subscribe URLs. No deployment needed.

The topic is stored inside the `UserRecord` in Redis (`checkinTopic`). The checkins route resolves it from Redis first, falling back to env vars for Alan/Claude/Rochisha whose topics were set before this system existed.

### Notification env vars per user

There is no in-app nudge modal anymore — pending goals are surfaced entirely via escalating text messages (below) for users with a phone number configured. The habit-completion push notification still fires when a user checks off a goal, so their accountability partner sees it:

| User | Completed habit |
|------|----------------|
| Alan | `NTFY_TOPIC` (legacy) |
| Claude | `NTFY_CLAUDE_TOPIC` |
| Rochisha | `NTFY_ROCHISHA_TOPIC` |
| Future | `NTFY_{USER_UPPER}_TOPIC` |

### Escalating text nudges (Sendblue + cron-job.org)

Any user with a `phone` set (via `/admin`, or `PATCH /api/users`) gets a text via [Sendblue](https://docs.sendblue.com) every hour, 8am–9pm PST, listing whichever habits are still pending — until they either complete the check-in or text back a reply. `lib/nudges.ts`'s `getPendingNudges` is the single source of truth for "is this goal pending". Vacation-paused goals (`getActiveVacation`) are excluded. A habit's `nudgeTime` (set per-goal in the habit form) gates when it *enters* the rotation — e.g. set to 6pm, the earliest possible nudge for that habit is the 6pm tick, then hourly after; it defaults to `"21:00"` if unset.

- **`app/api/nudge/dispatch/route.ts`** — the hourly tick. Requires header `x-nudge-secret` matching `NUDGE_DISPATCH_SECRET` (rejects with 401 otherwise — there is no unauthenticated path). Scheduled externally via [cron-job.org](https://cron-job.org)'s API (Vercel's Hobby-plan Cron can't run more than once/day, so it can't be used here) — the schedule itself encodes the 8am–9pm PST window via `schedule.hours`/`schedule.timezone`, and sends `x-nudge-secret` as a custom request header.
- **`app/api/nudge/inbound/route.ts`** — Sendblue's inbound-webhook target, registered via `POST https://api.sendblue.com/api/account/webhooks` with a chosen `secret`. Requires that secret to be echoed back (checked against `sb-webhook-secret`/`sb-signing-secret` headers or a `secret` body field — Sendblue's docs don't pin down the exact one, so all are checked; unverified requests always 401). Sendblue has no reply-to/thread field, so a reply is matched against the sender's *currently pending* habits by number or name (`nudge:snoozed:{goalId}:{date}`, per-goal) — naming a habit or its `nudgeNumber` snoozes just that one for the rest of the PST day; an explicit "stop"/"all"/"stop all"/"snooze all" reply snoozes everything pending. Anything else (a stray "ok", "on it", etc.) snoozes nothing — silence has to be intentional, not the default outcome of any reply.
- **`Goal.nudgeNumber`** (`lib/types.ts`) — a stable 1..N id per user, shown in nudge texts ("2. 🏋️ Gym") so a reply like "2" always means the same habit. `renumberGoals()` in `lib/kv.ts` reassigns it compactly whenever a goal is added or deleted (called from `app/api/goals/route.ts`'s `POST`/`DELETE`), and `getGoals()` backfills it for any pre-existing goal missing it. It tracks each goal's storage/creation order, not its drag-reordered display position — a habit's nudge number and its position in the home-screen list can differ.
- `lib/kv.ts`'s `claimNudgeSlot(userId, date, hour)` atomically claims (`SET NX EX`) a per-hour send slot *before* texting, so overlapping/retried dispatch calls for the same hour can never double-send.
- `lib/sendblue.ts`'s `sendText` is the only place that calls the Sendblue send API.

Env vars: `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET` (chosen by us, used both when registering the webhook and to verify inbound requests), `NUDGE_DISPATCH_SECRET` (chosen by us, given to cron-job.org as a custom header).

## Data model
Goals are stored as a JSON array at Redis key `goals` (Alan) or `{userId}:goals` (others).

Check-ins are stored per-day: `checkin:{goalId}:{YYYY-MM-DD}` → count. Weekly goals are tracked daily and aggregated — there are NO week-keyed checkin records anymore.

Reflections: `reflection:{goalId}:{YYYY-MM-DD}` → `{ text, savedAt }`. Always date-keyed (not week-keyed), for both daily and weekly goals.

Mood entries: `mood:{YYYY-MM-DD}` → list of `MoodEntry` JSON strings. Also increments `checkin:emotional-checkin:{date}`.

Weekly notes: `note:{YYYY-WXX}` → `WeeklyNote`. Seeded via `seedInitialWeeklyNote()`, `seedWeeklyNoteW22()`, etc., all called in the GET handler of `app/api/notes/route.ts` — only for Alan's namespace (`!user`). Other users start with empty notes.

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
- Salad upgraded from 6x/week to daily, preserving streak as `streakOffset` (June 2026)

Note: migrations in that block are Alan-only (`!userId`). A separate check right after it — `goals.some((g) => g.nudgeNumber == null)` — backfills `Goal.nudgeNumber` and runs for every user, since nudge numbering isn't Alan-specific.

## Adding a weekly note

The seed functions in `lib/kv.ts` are **lazy** — they only run the first time the notes API is hit, so a newly deployed seed won't appear until someone loads the app. To write a note immediately, write directly to Redis with curl.

### Immediate write (preferred)

Figure out the ISO week key first. "Last week" relative to the current date: count back to the Monday of that week, then use `YYYY-Www` format (e.g. Jun 22–28 2026 = `2026-W26`, week of Jun 22 = "Week of Jun 22").

```bash
curl -s -X POST "$UPSTASH_REDIS_REST_URL/set/note:2026-W26" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(node -e "
const note = {
  week: '2026-W26',
  weekLabel: 'Week of Jun 22',
  headline: 'Short headline here',
  notes: 'Prose summary of the meeting.',
  changes: [
    '🔑 Key point one',
    '🔑 Key point two',
  ],
  updatedAt: new Date().toISOString(),
};
process.stdout.write(JSON.stringify(note));
")"
```

**CRITICAL:** use `process.stdout.write(JSON.stringify(note))` — NOT `console.log(JSON.stringify(JSON.stringify(note)))`. Double-encoding stores a string-of-a-string in Redis; when the app reads it back `note.changes` is `undefined` and the page crashes with `TypeError: Cannot read properties of undefined (reading 'length')`.

Verify the write worked (result should be `dict`, not `str`):
```bash
curl -s "$UPSTASH_REDIS_REST_URL/get/note:2026-W26" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); v=json.loads(d['result']); print(type(v).__name__, list(v.keys()))"
```

The curl command is all that's needed — no seed functions, no code changes required.

## Dev
```bash
npm run dev        # localhost:3000
npm run deploy     # Vercel deploy via scripts/deploy.sh
```
Env vars needed: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (in `.env.local`).

## Goals currently tracked (as of June 2026)

**Alan:** Gym-split: HIIT (1x/week), Resistance training (1x/week) · Piano Session (3x/week) · Eye ointment (6x/week) · Stretch (2x/week) · Protein drink (1x/daily) · 7+ hr sleep · Salad · Emotional Check-in (mood/daily)

**Rochisha:** Empty — she sets her own goals from scratch at `/rochisha`.
