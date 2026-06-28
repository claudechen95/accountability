# Alan & Rochisha's Accountability App — Claude Code Context

Personal habit tracker. Next.js 14 app router, Upstash Redis (KV), deployed on Vercel. No auth — multi-user by URL path, fully isolated per user.

## Stack
- **Frontend:** `app/page.tsx` (landing page, lists users) + `app/[user]/page.tsx` (per-user tracker)
- **API routes:** `app/api/` — goals, checkins, history, notes, reflections, mood, settings, remind
- **Data layer:** `lib/kv.ts` — all Redis reads/writes. Import from here, never call Redis directly elsewhere.
- **Types:** `lib/types.ts` — `Goal`, `GoalStatus`, `WeeklyNote`, `CheckInRecord`, `MoodEntry`
- **Timezone:** Everything PST/PDT (`America/Los_Angeles`). Date strings are `YYYY-MM-DD`.

## Multi-user architecture

Users are identified by URL path (`/alan`, `/rochisha`). All API routes read `?user=` and pass it through the data layer.

**`resolveUser(param)`** in `lib/kv.ts` normalizes the param: `"alan"` and `null`/`""` both map to `undefined` (backward compat — Alan's data has no prefix). Any other value is returned as-is.

**`k(userId, key)`** namespaces Redis keys: `userId ? \`${userId}:${key}\` : key`. So Alan's `goals` key stays `goals`; Rochisha's becomes `rochisha:goals`.

All data is fully isolated: goals, checkins, history, reflections, mood, weekly notes, journal, settings, notification dedup flags.

### Adding a new user (complete checklist)

> **Critical:** always ADD to the `USERS` array — never replace an existing entry. Existing users have real data even if they look like placeholders.

1. **Landing page** — add to `USERS` in `app/page.tsx`:
   ```ts
   { id: "newuser", label: "New User" }
   ```

2. **Notification topic** — pick a hard-to-guess topic name (e.g. `newuser-nudge-abc123`) and add it in two places:
   - `.env.local`: `NTFY_NEWUSER_NUDGE_TOPIC="newuser-nudge-abc123"`
   - Vercel: `echo "newuser-nudge-abc123" | vercel env add NTFY_NEWUSER_NUDGE_TOPIC production`
   - The remind route resolves the key as `NTFY_{USERID_UPPERCASE}_NUDGE_TOPIC`

3. **Commit & deploy** — commit `app/page.tsx` and push; Vercel auto-deploys from `main`:
   ```bash
   git add app/page.tsx
   git commit -m "feat: add <name> as new user"
   git push   # or: npm run deploy
   ```

4. **Verify** — check the landing page at https://accountability-azure.vercel.app/ and confirm the new user link appears. New user starts with an empty goal list at `/{id}`.

No Redis setup needed — the same database is shared; data is automatically isolated under the `{userId}:` key prefix.

### Notification env vars per user
- Alan: `NTFY_ALAN_TOPIC` (legacy key, used when `userId` is `undefined`)
- Rochisha: `NTFY_ROCHISHA_NUDGE_TOPIC`
- Pattern for future users: `NTFY_{USER_UPPER}_NUDGE_TOPIC`

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

Note: migrations run for ALL users. Use `userId` checks inside a migration if it should only apply to one user.

## Adding a weekly note
1. Add `export async function seedWeeklyNoteWXX()` to `lib/kv.ts` (copy pattern from `seedWeeklyNoteW23`)
2. Import and call it in `app/api/notes/route.ts` GET handler alongside the other seeds (inside the `if (!user)` block — Alan-only)

## Dev
```bash
npm run dev        # localhost:3000
npm run deploy     # Vercel deploy via scripts/deploy.sh
```
Env vars needed: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (in `.env.local`).

## Goals currently tracked (as of June 2026)

**Alan:** Gym-split: HIIT (1x/week), Resistance training (1x/week) · Piano Session (3x/week) · Eye ointment (6x/week) · Stretch (2x/week) · Protein drink (1x/daily) · 7+ hr sleep · Salad · Emotional Check-in (mood/daily)

**Rochisha:** Empty — she sets her own goals from scratch at `/rochisha`.
