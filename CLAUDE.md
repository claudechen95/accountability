# Alan & Rochisha's Accountability App — Claude Code Context

Personal habit tracker. Next.js 14 app router, Upstash Redis (KV), deployed on Vercel. No auth — multi-user by URL path, fully isolated per user.

## Stack
- **Frontend:** `app/page.tsx` (landing page, lists users) + `app/[user]/page.tsx` (per-user tracker)
- **API routes:** `app/api/` — goals, checkins, history, notes, reflections, mood, settings, vacation, users, nudge/dispatch, nudge/inbound, coach
- **Data layer:** `lib/kv.ts` — all Redis reads/writes. Import from here, never call Redis directly elsewhere.
- **Types:** `lib/types.ts` — `Goal`, `GoalStatus`, `WeeklyNote`, `CheckInRecord`, `MoodEntry`
- **Timezone:** Everything PST/PDT (`America/Los_Angeles`). Date strings are `YYYY-MM-DD`.

**The tracker and history pages are server-rendered.** `app/[user]/page.tsx` and `app/[user]/history/page.tsx` (and the un-prefixed `/history`) are `async` server components that read Redis directly and pass the result to their client component as `initialGoals` / `initialHistory`.
Those props are optional: without them the view fetches on mount as it always did, which is what a client-side navigation and every other view still do.
`/api/goals`, `/api/vacation` and `/api/history` remain, and are what the client re-fetches after a check-in or at midnight - so any change to what those pages show has **two** call sites to keep in step. `getGoalHistories` in `lib/kv.ts` exists precisely so the history route and the history page can't drift.
See [Latency instrumentation](#latency-instrumentation) for why.

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

### Hiding bottom-nav tabs

`UserRecord.hiddenTabs` (a list of `TabDef.key`s) switches tabs off per user, edited at `/admin` and stored in the same `users` key as the phone numbers.
`lib/tabs.ts` is the single list of hideable tabs, shared by `BottomNav` and the admin toggles so a tab can't exist in one and not the other; the icons stay in `BottomNav` because they're JSX.
**Home has no key and can't be hidden** - it's the tracker, which is the app.
The stored set is the *hidden* one, so a record written before this existed reads as "show everything"; `setUserHiddenTabs` stores an empty set as absent to keep that a single shape, and drops keys that aren't tabs.
Alan currently hides Reflect and Coach.

**Hiding a tab is decluttering, not permission.** There's no auth here - the route still renders for anyone who types the URL or follows a bookmark, and nothing server-side checks `hiddenTabs`.

The list is read in **`app/layout.tsx`**, which is why that layout is now `async`. The nav is a client component and sits in the layout rather than in any page, so this is the only place the config can be fetched without a client round trip - and fetching it client-side would mean a hidden tab appearing on first paint and vanishing after hydration.
The cost is that `/`, `/mood`, `/notes`, `/history`, `/reflections` and `/coach` are now `ƒ` dynamic rather than `○` static shells, each paying one `get` of the small `users` key (~9ms from `sfo1`).
That's close to a wash rather than a regression: those pages all fetch their data on mount anyway, so the function was being woken either way - this moves the cold start ahead of the HTML instead of adding a second one. If it ever needs to come back, the lever is caching the `users` read specifically (it changes ~never, unlike habit state - see [Cold vs warm](#cold-vs-warm-and-why-theres-no-data-cache)), not un-hiding the tabs.

### Notification env vars per user

There is no in-app nudge modal anymore — pending goals are surfaced entirely via the escalating text/call ladder (below) for users with a phone number configured. The habit-completion push notification still fires when a user checks off a goal, so their accountability partner sees it:

| User | Completed habit |
|------|----------------|
| Alan | `NTFY_TOPIC` (legacy) |
| Claude | `NTFY_CLAUDE_TOPIC` |
| Rochisha | `NTFY_ROCHISHA_TOPIC` |
| Future | `NTFY_{USER_UPPER}_TOPIC` |

### Escalating nudges (Sendblue + Twilio + cron-job.org)

Any user with a `phone` set (via `/admin`, or `PATCH /api/users`) climbs a five-step ladder each day, per habit, until they complete the check-in.
`lib/nudges.ts` owns the whole schedule and is pure - the clock, weekday, and habit list are passed in - so nothing else computes when a step is due.

`normalizePhone` in `lib/kv.ts` canonicalizes both numbers to E.164 on write, and `findUserByPhone` normalizes both sides of the comparison so numbers stored before it existed still match.
This is load-bearing for inbound replies only: Sendblue and Twilio both parse loose forms like `+1 929 213 7480` on *send*, but Sendblue reports an inbound sender in strict E.164, so a formatted stored number silently matched no user and dropped every snooze.

**Everything in steps 1-4 is scheduled per habit, off that habit's own `nudgeTime`.** The user-level ladder is only step 5.

| Step | When | What |
|------|------|------|
| 1-3 | `nudgeTime`, then evenly spread to `DAY_END` | Text via Sendblue |
| 4 | `habitCallStart` — `ESCALATION_DELAY_MIN` (10 min) after *that habit's* last text — then retried every `CALL_RETRY_MIN` (10 min) up to `MAX_CALL_ATTEMPTS` (3) | Phone call via Twilio |
| 5 | `PARTNER_ALERT_DELAY_MIN` (30 min) after the last call attempt of the day, once no habit has an attempt left | Text to the user's `partnerPhone` |

A 21:00 habit texts at 21:00/21:20/21:40 and calls at 21:50/22:00/22:10; a 13:25 habit texts at 13:25/16:17/19:08 and calls at 19:18/19:28/19:38, on the same evening, without either waiting for the other.
**This means a bad night can be a lot of phone calls** — four habits on four different clocks is up to twelve. In practice answering any one of them sets `nudge:call-reached:{date}` and ends the day for all of them, and so does replying to any text, so twelve is the ignore-everything worst case rather than the normal one.

Two consequences of per-habit calls worth keeping in mind:
- **Texts and calls no longer exclude each other.** The dispatch route used to short-circuit into a single call phase once the clock passed a user-level cutoff, which meant a habit whose `nudgeTime` was past that cutoff (Piano Session at 22:30, Emotional Check-in at 22:00) got neither a text nor a call and went silent all day. There is no cutoff now: a habit can be sending its first text on the same tick another is being called about. Pinned by two regression tests in `nudge-ladder`.
- **Habits due on the same tick share one call.** Dialling the same number twice in one tick would put the second on a busy signal, so `dueCalls` is claimed per habit but placed as a single call naming all of them.

`habitCallStart` is uncapped, so a habit configured past `DAY_END` gets one text (`nudgeSlots` can't divide a closed span) and then its own ladder a tick later, rather than being dropped.

The times come from the *habit*, not from the cron tick: `nudgeSlots(nudgeTime)` divides the span from `nudgeTime` to `DAY_END` into thirds, so a habit always gets exactly three texts before the call.
Set to 9am they land 4h20m apart (9:00, 13:20, 17:40); set to 9pm they land 20 minutes apart (21:00, 21:20, 21:40).
`nudgeTime` defaults to `"21:00"` and the habit form caps it at 21:00, since past that there's no span left to divide.
`getPendingNudges` is the single source of truth for "is this goal pending", and gates a habit out of the ladder entirely until its `nudgeTime` has passed.
Vacation-paused goals (`getActiveVacation`) and graduated goals are excluded.

**Any reply ends the day.** `markReplied` sets `nudge:replied:{date}` on *any* non-empty inbound text, and the dispatch route checks it before reading anything else, so the remaining texts, all call attempts, and the partner alert are all skipped.
The bar is deliberately low - "ok" clears it - on the principle that the escalation exists to reach a person and a reply proves it did, which is the same reason answering the phone (`nudge:call-reached:{date}`, set by `markCallReached`) also ends the ladder.

⚠️ **This makes the per-habit snooze path unreachable.** `nudge:snoozed:{goalId}:{date}` is still written by the inbound route and still read by the dispatch route, but no reply can now set the snooze flag without also setting `nudge:replied`, and the reply check short-circuits first.
So the snooze filtering in `app/api/nudge/dispatch/route.ts`, the "Snoozed today:" line, and the reply-matching that `Goal.nudgeNumber` exists to serve are all effectively dead - `nudgeNumber` survives only to name habits back in the confirmation text.
The older guarantee that **snoozing never silenced your partner** no longer holds either, since the reply that snoozes also ends the day.
This is a consequence of choosing "any reply ends the ladder", not an accident; it is written down here because the code still reads as though the snooze mattered.

- **`app/api/nudge/dispatch/route.ts`** — the tick. Requires header `x-nudge-secret` matching `NUDGE_DISPATCH_SECRET` (rejects with 401 otherwise — there is no unauthenticated path). Scheduled externally via [cron-job.org](https://cron-job.org)'s API (Vercel's Hobby-plan Cron can't run more than once/day, so it can't be used here) — the schedule encodes an **every-10-minutes, 8am–11pm PST** window via `schedule.hours`/`schedule.minutes`/`schedule.timezone`, and sends `x-nudge-secret` as a custom request header. The tick rate itself carries no meaning; it only has to be at least as frequent as the tightest slot spacing (20 min, for a 21:00 habit). Its *end* does matter now that calls are per habit and uncapped: a habit's ladder runs 10, 20 and 30 minutes past its last text, and the partner alert another 30 after that, so a habit configured much past 21:00 can have steps that fall outside the window and simply never fire. A 21:00 habit finishes comfortably (calls 21:50–22:10, partner 22:40); a 22:30 one does not.
- **`lib/call.ts`** — `placeCall` is the only place that talks to a voice provider, the same seam `lib/sendblue.ts` gives texts. Inline TwiML (no hosted callback URL, since the call is one-way, so there's no public webhook to authenticate), `Polly.Matthew`, `loop="2"` because a single pass is easy to miss on pickup, and habit names spoken without emoji, which read badly in TTS. `callScript` in `lib/nudges.ts` builds the spoken text. `isCallConfigured()` gates on the Twilio env vars being present, so an unconfigured deployment just stops the ladder after step 3 instead of erroring every tick.
  **Twilio reports a voicemail pickup as `completed`, exactly like a human answering** — declining a call in a meeting therefore looks identical to taking it, which would make the retry loop stop on the one case it exists for. Two things separate them, neither needing a public webhook: `Timeout: 20` (shorter than the ~25-30s most carriers wait before diverting, so an unanswered call rings out to an honest `no-answer`) and `MachineDetection: "Enable"` (populates `answered_by` for whatever answers fast enough to beat the timeout). `getCallOutcome(sid)` collapses status + `answered_by` into `reached` / `missed` / `pending`, polled on the *following* cron tick rather than pushed to a callback. `unknown` and an absent `answered_by` both count as `reached`: failed detection isn't evidence of a machine, and ringing someone three times because Twilio couldn't classify them is the worse error. AMD also removes the need for a leading `<Pause>`, since detection already withholds the TwiML until the callee is classified.
- **`app/api/nudge/inbound/route.ts`** — Sendblue's inbound-webhook target, registered via `POST https://api.sendblue.com/api/account/webhooks` with a chosen `secret`. Requires that secret to be echoed back (checked against `sb-webhook-secret`/`sb-signing-secret` headers or a `secret` body field — Sendblue's docs don't pin down the exact one, so all are checked; unverified requests always 401). **Any non-empty reply calls `markReplied`, which ends that day's ladder outright** — no further texts, no calls, no partner alert. Sendblue has no reply-to/thread field, so a reply is *also* matched against the sender's currently pending habits by number or name and writes `nudge:snoozed:{goalId}:{date}`, but that no longer changes what gets sent (see the warning above); it survives only so a reply of "2" can be echoed back as "🏋️ Gym" rather than as a bare acknowledgement. The confirmation text deliberately states the whole effect ("Nudges are off for the rest of today") rather than naming just the matched habit, which would read as if the others were still live.
- **`Goal.nudgeNumber`** (`lib/types.ts`) — a stable 1..N id per user, shown in nudge texts ("2. 🏋️ Gym") so a reply like "2" always means the same habit. `renumberGoals()` in `lib/kv.ts` reassigns it compactly whenever a goal is added or deleted (called from `app/api/goals/route.ts`'s `POST`/`DELETE`), and `getGoals()` backfills it for any pre-existing goal missing it. It tracks each goal's storage/creation order, not its drag-reordered display position — a habit's nudge number and its position in the home-screen list can differ.
- Every step claims its slot (`SET NX EX`, all expiring at PST midnight) *before* sending, so overlapping or retried dispatch calls can never double-send: `claimNudgeSlot(userId, goalId, date, slotIndex)` → `nudge:sent:{goalId}:{date}:{slot}` (per goal, so each habit escalates on its own schedule), `claimEscalation` → `nudge:escalated:{date}`, `claimCallAttempt(userId, goalId, date, attempt)` → `nudge:call:{goalId}:{date}:{attempt}` (per goal like the text slots, holding `{at, sid}`, the sid written back once Twilio accepts so the next tick can poll it — habits sharing a merged call share its sid), `claimPartnerAlert` → `nudge:partner-alerted:{date}`.
- `dueSlotIndices` returns *every* passed slot, not just the latest, so a dispatch outage burns the slots it slept through rather than replaying them one per later tick, which would push a habit's third text past the call it's meant to precede.
- `nextCallTime` deliberately does the **opposite**, scheduling each retry off when the previous call actually went out rather than off a fixed timetable — so an outage delays the call ladder instead of burning the attempts it slept through. The asymmetry is intentional: a text slot missed is a reminder lost, and replaying it late would crowd the call it's meant to precede, whereas a call attempt missed is a chance to reach someone that's still worth taking a tick late. It also means the backoff can't compress two attempts into one tick after a gap.
- `lib/sendblue.ts`'s `sendText` is the only place that calls the Sendblue send API.
- ⚠️ **Never put a carrier opt-out keyword in an outbound message.** `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END` and `QUIT` are intercepted by the carrier *ahead of* Sendblue on SMS: they block every future message from that sender permanently — transactional included, not just for the day — and the inbound webhook never fires. The failure is silent and backwards: `markReplied` never gets set, so the ladder carries on calling and alerting the partner about texts that can no longer be delivered, and undoing it needs the user to text `START` to their carrier, not any change here. The nudge text used to end with `or "stop" to snooze all`, which was exactly that trap. Sendblue additionally auto-detects `stop, unsubscribe, cancel, opt out, revoke, end, quit` (and `start` to reactivate) on its own, so this bites on iMessage too rather than only on SMS fallback, and there is **no API to query whether a number is opted out**. The text now reads `Reply "pause" to mute today's nudges.` — naming a safe word rather than saying "reply anything", since any reply does end the day but a free-form invitation is an invitation to improvise "stop" or "cancel". A test in `nudge-ladder` word-boundary-matches every outbound message against the reserved list (word boundaries because "pending" contains "end").

Env vars: `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET` (chosen by us, used both when registering the webhook and to verify inbound requests), `NUDGE_DISPATCH_SECRET` (chosen by us, given to cron-job.org as a custom header), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.

## Data model
Goals are stored as a JSON array at Redis key `goals` (Alan) or `{userId}:goals` (others).

Check-ins are stored per-day: `checkin:{goalId}:{YYYY-MM-DD}` → count. Weekly goals are tracked daily and aggregated — there are NO week-keyed checkin records anymore.

Reflections: `reflection:{goalId}:{YYYY-MM-DD}` → `{ text, savedAt }`. Always date-keyed (not week-keyed), for both daily and weekly goals.
One reflection can be filed under several dates: `reflectionDateKeys` writes a **daily** goal's text to every missed day the prompt just named (falling back to yesterday if nothing is outstanding), so the grid marks the whole run reflected rather than its last day alone. A **weekly** goal's is about the week, so it stays under the single day it was written.

Mood entries: `mood:{YYYY-MM-DD}` → list of `MoodEntry` JSON strings. Also increments `checkin:emotional-checkin:{date}`.

Target history: `target-history:{goalId}` → list of `TargetChange` JSON strings, appended chronologically (`rpush`), one per target the habit has had.

Weekly notes: `note:{YYYY-WXX}` → `WeeklyNote`. A note is a headline plus the meeting's three sections - `wentWell`, `didntGoWell`, `actionItems`, each a `string[]` of bullets. `notes` (a single prose body) and `changes` (a progress log) are the retired shapes that preceded them: both are optional, nothing writes them any more, and `NoteCard` still renders them so notes written before the sections existed read back whole. Notes are being converted to sections backwards from the newest, per namespace, each rewritten in place with its `notes`/`changes` dropped. **Alan** (`note:*`): `2026-W37`/`W35`/`W34` when the sections were introduced, then `W29`/`W28`/`W27` (Sep 2026); `W30`–`W33` are empty "Vacation" placeholders, so `W13`–`W26` still carry prose. **Claude** (`claude:note:*`): `2026-W37`/`W35`/`W34` (Sep 2026); `W30`–`W33` are empty, so `W25`–`W29` still carry prose. Note that several pre-conversion bodies type their own `What went well` / `What did not go well` / `Action items` headings *inside* the prose blob, which renders as an unformatted wall of text - that's the tell for a note that still needs converting. When searching for notes to convert, glob `*note:*` rather than `note:*`, or the prefixed namespaces are silently missed. Keyed by **ISO-8601 week** (Monday-start; week 1 contains Jan 4; the year is the ISO year, so Mon Dec 29 2025 is `2026-W01`). `getWeekKey` in `lib/kv.ts` is the only thing that should compute one - `NotesView`'s client-side `getWeekKeyForDate` mirrors it and must stay in step. Until Aug 2026 `getWeekKey` phased weeks off Jan 4's weekday instead, so in 2026 it returned Sunday–Saturday weeks numbered one below ISO: on Wed Aug 26 it produced `2026-W34`, the key already holding the note labelled "Week of Aug 17", so writing "this week" would have overwritten last week's note. Stored notes were unaffected (their keys and labels were already ISO-correct), so the fix was to `getWeekKey` alone with no data migration. `legacyWeekKey` preserves the old numbering solely to read the two pre-existing `checkin:gym:2026-W1x` keys via the legacy fallback in `getWeeklyDaysCompleted`. Seeded via `seedInitialWeeklyNote()`, `seedWeeklyNoteW22()`, etc., all called in the GET handler of `app/api/notes/route.ts` - only for Alan's namespace (`!user`). Other users start with empty notes.

## Goal schema
```ts
interface Goal {
  id: string;
  name: string;
  emoji: string;
  frequency: "daily" | "weekly";
  targetCount: number;
  type?: "mood";        // only on emotional-checkin
  order?: number;       // drag-to-reorder position
  nudgeDays?: number[]; // 0=Sun…6=Sat; weekly goals only
  nudgeTime?: string;   // "HH:MM" PST; gates when a habit enters the text-nudge rotation
  nudgeEnabled?: boolean; // daily goals only; opt out of nudging, default true
  nudgeNumber?: number; // stable per-user 1..N id used in nudge texts ("reply 2")
  graduatedAt?: string;   // YYYY-MM-DD; presence = graduated, i.e. no longer tracked at all
  graduatedRun?: number;  // run frozen at graduation: days (daily) or weeks (weekly)
  graduationSnoozedUntil?: string; // YYYY-MM-DD; "not yet" on the graduation offer
}
```

## Key behaviors
- **Goal ordering:** Drag-and-drop via `@dnd-kit`. Done goals always sink to bottom. Order persisted via `PATCH /api/goals` with `{ orderedIds: string[] }`.
- **Reflection prompt:** `getReflectionPrompt()` in `lib/kv.ts` is the single source of truth for whether to ask, why, and whether the user can decline.
  It returns a `ReflectionPrompt` (`lib/types.ts`) on `GoalStatus.reflection`, or `null` for "don't ask"; the client also requires `todayCount === 0`, so a goal prompts at most once a day.
  Daily goals prompt with `missed-day`, which carries **every** missed day in the last `REFLECTION_LOOKBACK_DAYS` (14) that hasn't been reflected on yet, oldest first - not just yesterday.
  Asking only about yesterday left two kinds of miss permanently unreachable, because the prompt fires on the *next check-in*: a day in the middle of a run (only the run's last day was ever a candidate), and a day whose next check-in came from the history grid's backfill, which doesn't go through the prompt at all.
  Across 91 days of one daily habit that was 8 days and 2 days respectively, against 5 reflections actually collected.
  `getUnreflectedMissedDays` excludes vacation days, days that already carry a reflection (re-asking would overwrite the answer), and days before the habit's first check-in - the last read off the tail of `history:{goalId}`, without which a habit added yesterday opens with a fortnight of misses it wasn't around for.
  The window is bounded rather than open-ended because a reflection written in October about a day in June isn't a reflection, and because a dismissed prompt would otherwise re-ask forever.
  Weekly goals are judged against the whole week, not a single day: a 3x/week habit skipped on Tuesday with four days still open is not behind and is not asked anything.
  They prompt only when the days still open no longer outnumber the days still needed (`week-behind`), or when nothing is logged yet this week and last week closed below target (`week-missed`, capped at once per week).
  Vacation-paused days are dropped from the days remaining and prorate the target down, so a partly-paused week can't be "missed" for days the user was never expected to show up.
- **Required vs optional reflections:** `ReflectionPrompt.required` decides whether the reflection can be waved away.
  A period that's already lost - yesterday, a closed-out week, a week whose target is now unreachable - is `required`; a knife's-edge week that's still winnable is not.
  A daily prompt is `required` only when **yesterday** is one of the days it names: that's the one that has only just been lost. An older backlog is raised but not charged for, since a toll the user can't clear by doing the right thing today is how a prompt turns into something people learn to dismiss.
  A required prompt drops the "just check in, skip reflection" link and needs `MIN_REFLECTION_CHARS` (15) before the check-in button enables.
  It still closes via ✕ or backdrop, but closing does **not** check the habit in - that's the whole point, since the old skip link handed over the check-in for one tap.
  This is UX friction, not enforcement: `POST /api/checkins` has no server-side gate (no auth, personal app), and backfilling past days from the history grid can still raise a week's count.
- **Emotional Check-in** (`id: "emotional-checkin"`, `type: "mood"`): Opens mood emoji picker. "Log another" instead of "undo" when done. No position pin — user controls via drag.
  `MoodModal` opens on a `REFLECT_SECONDS` (5) countdown showing "Reflect on your whole day." before the wheel, so an entry is a read on the day rather than a reflex tap on the last ten minutes.
  The wheel is not mounted until the countdown ends - its slide-to-explore tutorial should play when the user arrives at it, not behind the countdown - and the countdown panel is height-matched to the wheel step so the sheet doesn't jump.
  There is no skip; ✕ and the backdrop still close the modal outright.
- **Target history:** every change to a habit's `frequency`/`targetCount` is appended to `target-history:{goalId}` and drawn as a step chart ("Target over time") under that habit's grid on the history page.
  `recordTargetChange` in `lib/kv.ts` is called from `POST /api/goals` on every goal write and is a no-op unless the target actually moved, so renaming a habit or moving its nudge time logs nothing.
  **It is a log, not a scoring input.** `getHistory`, both streaks and graduation all still judge every past period against the habit's *current* target; nothing reads target history to decide whether a day or a week was met.
  `lib/target-history.ts` holds the pure part: `weeklyEquivalent` puts daily and weekly targets on one per-week axis (6x/week → daily is a step **up**, 6 → 7, which plotting raw `targetCount` would draw as a collapse to 1), and `buildTargetTrend` collapses records into segments, returning `null` when the target never moved so an unchanged habit gets no chart.
  Two wrinkles worth knowing: several edits on one day collapse to the last (3x → 4x → 3x in one sitting is no change, not two steps), and a habit that predates this feature has no record of what it was changing *from*, so the first change writes a `backfilled` record of the old target whose date is the date we noticed rather than the true start - which is why the chart draws the run before the first change as a dashed, open-ended line.
- **Streak units:** the history card labels the streak "day streak" or "week streak" per `goal.frequency`. A bare "🔥 9" on a card showing three months of grid reads as weeks even when it's days.
- **Backfill:** Click a missed (gray) cell in the history grid to log it for that date. `POST /api/checkins` accepts `{ goalId, date }`.
- **Reflections in the grid:** a cell's *fill* is the outcome (green done, gray missed, sky vacation) and an **amber inset ring** means "a reflection was written on this day", readable in the cell's tooltip.
  The two are separate because a reflection is not evidence of a miss: `getReflectionDateKey` files a **weekly** goal's reflection under the day it was *written*, and the modal writes it seconds before the check-in it was gating - so that day is almost always green.
  The grid used to read `reflections[period]` only when the cell was missed and paint it amber instead of gray, which silently dropped every reflection a weekly habit collected on a day it completed (7+ hr sleep had three from Sep 2026 stored and none on screen), and also cost "missed" its own colour.
- **Weekly streak for weekly goals:** Counted in weeks, not days. `getWeeklyStreak()` walks back 52 weeks.
- **Graduation:** A habit the user has decided is automatic. `Goal.graduatedAt` (a `YYYY-MM-DD`) is the flag - its presence *is* "graduated", and `graduatedRun` freezes the run it had earned at that moment.
  Graduating **stops tracking entirely**: no check-ins (`addCheckIn` throws `GraduatedGoalError`, which `POST /api/checkins` turns into a 409), no text nudges (`getPendingNudges` filters them out), no reflection prompts (`getReflectionPrompt` returns `null`), and no streak recomputation - `getGoalStatuses` short-circuits to the frozen values instead of hitting Redis, and `app/api/history` reports `graduatedRun` rather than a streak that would only decay.
  The habit leaves the tracked list for a collapsible trophy shelf of emoji medallions at the top of the home screen (`TrophyShelf` in `HabitTracker.tsx`); "start tracking again" on a medallion is the only way back, since there is no automatic un-graduation.
  `getReflectionPrompt` and `getGoalStatuses` both key off `isGraduated()`, so that helper is the single definition.
  **Suggesting it:** `GoalStatus.canGraduate` drives an in-card offer once the run reaches `GRADUATION_PERIODS` (4) consecutive periods at target - 28 days for a daily habit, 4 weeks for a weekly one. Mood goals are never eligible (a journal isn't a habit to master). "not yet" sets `graduationSnoozedUntil` 14 days out; un-graduating sets it too, so a habit just taken off the shelf isn't immediately re-offered.
  All three actions go through `PATCH /api/goals` with `{ goalId, graduation: "graduate" | "ungraduate" | "snooze" }` (the same PATCH also still handles `{ orderedIds }` for drag-reorder).
  `nudgeNumber` is deliberately *not* renumbered on graduation, so a habit's reply number survives a round trip to the shelf and back.
  **In the history tab, a graduated habit's card is frozen rather than rolling forward.**
  `goalHistoryLabels` in `lib/kv.ts` ends its 91-day window at `graduatedAt` instead of today, and the target chart is passed the same end date, so the whole card reads as the run that earned the graduation.
  This is the single decision the rest follows from: nothing can ever be recorded after graduation (`addCheckIn` throws, so no check-in and no backfill), which made every post-graduation cell one that could never be filled.
  They used to be drawn in a third neutral colour and excluded from the completion-rate denominator - so once graduation fell more than 91 days back, *every* day in range was excluded, the denominator hit zero, and a habit that graduated for a perfect run rendered as a blank grid reading **0%**.
  With the window frozen there are no such days left: the neutral colour, its legend swatch and the denominator exclusion are all gone, and `getHistory`'s entries no longer carry a `graduated` flag at all.
  The card is also demoted out of the tracked list into a collapsible "🏆 Graduated · N" section at the bottom of the page (`GraduatedSection` in `HistoryView.tsx`), mirroring `TrophyShelf` on the home screen - collapsed by default where the shelf is open, since these are full-height cards rather than a row of medallions.
  Its backfill handler is withheld (a graduated habit's cells would hand the user a tap that can only come back a 409) and its streak pill reads "final run" rather than "day streak", since the number was frozen and isn't still running.
- **Vacation mode:** Per-user, per-habit pause (`VacationWindow { startDate, endDate, goalIds }` in `lib/kv.ts`, key `settings:vacation`). Can be scheduled for a future `startDate`, not just started immediately — `getActiveVacation` only returns a window once `startDate <= today`, so a scheduled-but-not-started window pauses nothing yet; `getUpcomingVacation` surfaces it for display before then. `endVacationNow` trims an active window to end yesterday (preserving vacation-day history) or, for a not-yet-started window, deletes it outright since nothing happened yet to preserve. `startVacation` always replaces any window that hasn't fully ended (active or upcoming) — only one vacation window is tracked "in flight" at a time.

## Coach chat (digital twin)

Per-user chat (`/[user]/coach`, `app/components/CoachView.tsx`) with an LLM persona grounded in transcripts of a personal-development audio program (owned by Alan, ingested for strictly personal/private use — not distributed). Architecture:
- **`lib/vector.ts`** — `searchTranscripts(query, topK)` semantic-searches the ingested transcript chunks via Upstash Vector's hosted-embedding `data` field (no separate embeddings step). The index is **shared with the unrelated `provenance-mcp` project** (same Upstash Vector database/credentials, which live in both repos' `.env.local`) — this app's chunks live in the `coach-transcripts` namespace so they never collide with provenance-mcp's zod-commit vectors in the default namespace.
- **`scripts/ingest-transcripts.mjs`** — one-time/manual script (`node scripts/ingest-transcripts.mjs <folder>`) that walks a folder of `Day N .../*.txt` transcripts, strips timestamp/speaker markup, chunks (~3000 chars, ~300 overlap), and upserts into the `coach-transcripts` namespace with deterministic ids (`day-session-chunkIndex` slug) — safe to re-run.
- **`lib/coach.ts`** — builds the system prompt (persona instructions + retrieved excerpts) and streams a reply via `@anthropic-ai/sdk` (`claude-sonnet-5`).
- **`lib/kv.ts`**'s `CoachMessage`/`getCoachMessages`/`addCoachMessage` — chat history stored the same way as `journal`/`mood` (`rpush`, chronological order), key `coach:chat` / `{userId}:coach:chat`.
- **`app/api/coach/route.ts`** — `GET` returns history; `POST { message, attachments? }` saves the user message, retrieves excerpts, and streams the assistant reply as plain text, persisting the full text once the stream ends.
- **Attachments** — the user can attach text files, images, or PDFs to a single message (paperclip button in `CoachView.tsx`, read client-side via `FileReader`). These are **one-off context for that turn only** — never persisted as files or added to the vector index. Text attachments get appended into the persisted message text (so they naturally stay in later turns' history context); images/PDFs are sent as base64 content blocks (`ChatAttachment` in `lib/coach.ts`) to Claude for that turn only, with just a `[Attached image: ...]`-style marker persisted to history. Server-side caps in `app/api/coach/route.ts`: 5 attachments/message, 50k chars/text file, ~10MB/binary file.
- **Inline citations** — `lib/coach.ts`'s `CITATION_INSTRUCTION` tells the model to cite `(Day — Session)` inline whenever a point is actually drawn from a retrieved excerpt, and to skip citing when it's speaking from general principles or the user's own attached material. `renderBold()` in `CoachView.tsx` renders the `**bold**` markdown the coach's replies use for step/section headers.
- **Retrieval is context-aware, not just the literal last message** — `app/api/coach/route.ts` builds the `searchTranscripts` query from the prior turn's text + the new message (not the new message alone), so short follow-ups like "add your references" or "tell me more" retrieve excerpts about the topic under discussion instead of searching on the follow-up's own (semantically empty) text.
- **`scripts/backfill-coach-citations.mjs`** — one-time/manual script (`node scripts/backfill-coach-citations.mjs [user]`) that retroactively adds citations to assistant replies that predate `CITATION_INSTRUCTION`. Re-derives the original query from each user message (strips the `\n\n--- filename ---`/`\n\n[Attached...]` attachment markers off first), re-runs `searchTranscripts`, and asks Claude to insert citation markers into the *existing* reply text without rewording anything else. Idempotent (skips replies that already have a `(Day N` citation) and non-destructive (`kv.lset` updates one list index in place; skips rather than guesses when nothing in a reply is actually excerpt-grounded).
- Env vars: `UPSTASH_VECTOR_REST_URL`, `UPSTASH_VECTOR_REST_TOKEN`, `ANTHROPIC_API_KEY` (all currently copied from `provenance-mcp/.env` — see above).

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
  // The meeting's four sections. One string per bullet - the card renders each list, and the
  // form edits each as one-bullet-per-line in a textarea.
  wentWell: ['...'],
  didntGoWell: ['...'],
  actionItems: ['...'],
  // `notes` (prose body) and `changes` (progress log) are both retired - new notes omit them.
  // NoteCard still renders them for notes written before the sections existed, and NoteForm
  // passes them back through on edit so editing an old note doesn't blank its prose.
  updatedAt: new Date().toISOString(),
};
process.stdout.write(JSON.stringify(note));
")"
```

**CRITICAL:** use `process.stdout.write(JSON.stringify(note))` — NOT `console.log(JSON.stringify(JSON.stringify(note)))`. Double-encoding stores a string-of-a-string in Redis, so the app reads the note back as a string rather than an object and the card renders with no label, no headline and no sections.

Verify the write worked (result should be `dict`, not `str`):
```bash
curl -s "$UPSTASH_REDIS_REST_URL/get/note:2026-W26" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); v=json.loads(d['result']); print(type(v).__name__, list(v.keys()))"
```

The curl command is all that's needed — no seed functions, no code changes required.

## Dev
```bash
nvm use              # node 20.20.2, per .nvmrc — the version CI runs
npm run dev          # localhost:3000
npm run deploy       # git push (Vercel deploys from main) via scripts/deploy.sh
npm run verify       # the full CI sequence — run this before pushing
npm run verify:quick # lint + typecheck + test, for the inner loop
npm test             # vitest run
npm run test:watch   # vitest in watch mode
```
Env vars needed: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (in `.env.local`).

### Local/CI parity

`npm run verify` mirrors `.github/workflows/ci.yml` step for step — env check, lock check, lint, typecheck, test, build — so a green verify means a green CI. Change one and change the other.

The toolchain is pinned in **`.nvmrc` (20.20.2)**, which CI reads via `node-version-file` and `nvm use` reads locally. npm is not pinned separately; it's whatever that node ships (10.8.2), so matching node matches both. `engines` in `package.json` records the pair and `scripts/check-env.mjs` fails the build when the running toolchain isn't it (`SKIP_ENV_CHECK=1` overrides).

This is not ceremony — it's the fix for a failure that actually happened. CI asked for `node-version: 20`, which resolved to whatever 20.x was newest that week; local dev ran a different node with a different bundled npm. npm versions disagree about which optional peer deps belong in a lock file, so `package-lock.json` written locally by npm 11.6 was **rejected outright** by CI's npm 10.8 (`Missing: @emnapi/core from lock file`), and `npm ci` died before lint, test or build ran at all. CI was red for several pushes that way, and nothing run locally could reproduce it. `npm run check-lock` (`npm ci --dry-run`) is the second half of that fix: it catches a desynced lock in about a second, which is the one failure mode that a passing local test suite says nothing about.

## Latency instrumentation

Upstash is REST: every command is its own HTTPS round trip, with no pipelining anywhere in `lib/kv.ts`.
So what decides whether a page feels instant is almost entirely **how many commands a request issues**, and that number is invisible in the code — it's the product of a per-goal loop and a per-day loop several call frames apart.
`lib/perf.ts` counts it.

- **`instrumentRedis`** wraps the client in `lib/kv.ts`. Every command is counted and timed against the current request, and the keys of every *read* are recorded so re-reads within one request are visible.
- **`span(name, fn)`** times a named block. Spans run concurrently, so summed span time exceeds the request's wall clock — the count and the per-span total are what's meaningful, not the sum.
- **`withPerf(label, handler)`** wraps every handler in `app/api/*/route.ts`. It logs one line per request and sets `Server-Timing`, so the same numbers appear in the browser's network panel next to the request that caused them. `measure()` is the same thing for server components (`app/page.tsx`).
- **`lib/client-perf.ts`**'s `timedFetch` replaces `fetch` for every `/api/` call in the view components, and reads `Server-Timing` back off the response so the client wait and the server time land on one line. `logFirstData(view)` logs navigation-start → first-content, which is the only number that includes the JS download and hydration that must finish before the first fetch is even issued — no server log contains it.

Collection is always on (a counter and a `performance.now()` per command). `PERF_VERBOSE=1` adds the per-span, per-command and re-read breakdown:

```bash
PERF_VERBOSE=1 npm run dev
# [perf] GET /api/goals 335ms | redis=135cmd/332ms | keys=252uniq/183repeat | spans: … | re-read: settings:vacationx26 · …
```

`redis=Ncmd/Mms` is command count and the wall-clock time with *at least one* command in flight — compare `M` to the request total to see how much of a route is Redis and nothing else. `keys=Xuniq/Yrepeat` is the waste measure: `Y` is how many reads asked for a key this request had already fetched.

### What it found, and what fixed it

Measured Sep 2026 against Alan's 13 habits at ~12ms RTT to Upstash. `GET /api/goals` issued **135 round trips** and was 99% Redis-blocked; the home page took 778ms to show a habit.

| | before | after |
|---|---|---|
| `/alan` first content | 778ms | **332ms** |
| `/alan/history` first content | 872ms | **232ms** |
| goals query | 335ms, 135 cmds | **179ms, 20 cmds** |
| history query | 557ms, 117 cmds | **111ms, 39 cmds** |
| `/api/mood` | 727ms, 55 cmds | **25ms, 2 cmds** |
| `/api/notes` | 321ms, 25 cmds | **34ms, 2 cmds** |

Four distinct causes, each with its own fix:

1. **Duplicate reads — 42% of `/api/goals`'s key reads were for keys it had already fetched.** `settings:vacation` was read 26 times, once per goal by each of `getDailyStreak`, `getWeeklyStreak` and `getReflectionPrompt`; each habit's current-week keys three or four times. No single call site was wrong, which is why **`lib/request-cache.ts`** fixes it at the request level instead: a read-through cache opened by `withPerf` for the length of one request. It stores the **promise**, not the value — the duplicate callers run inside one `Promise.all`, so they all ask before any answer arrives and a value cache would miss every time. Every write in `lib/kv.ts` calls `invalidate()` for the keys it touched. Outside a request it's a transparent passthrough.
2. **Breadth — `getGoalStatuses` ran four Redis-hitting functions per goal, unbatched.** `primeDayKeys` and `primeHistoryLengths` now fetch every goal's per-day keys (one `mget`: the current week, plus each daily goal's reflection lookback window) and every goal's history length and first check-in (one pipeline) *before* the per-goal fan-out, so the per-goal calls are cache hits.
   An `mget`'s cost is the round trip and almost nothing else - measured flat at ~10ms from 13 keys to 390 - so what matters is that each of these stays *one* command however many habits and days it covers, not how wide it is. These two functions are the only places that know a fan-out is happening; nothing downstream had to learn it. `primeTargetHistories` does the same for the history page's 13 `lrange`s.
3. **Depth — `getDailyStreak` was a `for` loop of up to 365 awaited single `get`s**, so its cost scaled with the streak it was measuring: a 100-day streak meant 100 serialized round trips. Both streak walks now read a block at a time (`STREAK_DAY_BLOCKS`, `STREAK_WEEK_BLOCKS`), fetching the next block only if the previous ran out with the streak still alive. The blocks **grow** (14, 28, 56, 112, 155 days) rather than being one fixed width — the first attempt used a flat 60 and was a wash, because `mget` is not free per key: a 73-key `mget` measured 45ms against 12ms for a small one, and 13 goals each pulling 60-80 keys cost more in payload than the round trips it saved.
4. **The client-render waterfall — 350ms elapsed before the first fetch was even issued.** The tracker was a client component that shipped a skeleton, so the document → chunks → hydrate chain had to finish first. Those pages are server-rendered now (see [Stack](#stack)).

`getAllMoodEntries` and `getAllWeeklyNotes` were separate, simpler N+1s: a `keys` scan followed by one `lrange`/`get` per key. Now a `keys` scan plus one pipeline/`mget`.

### Region: the function must sit next to Redis

**`vercel.json` pins `regions: ["sfo1"]`, and that is not cosmetic — it was worth more than every code change above combined.**

The Redis database resolves `awake-horse-74703.upstash.io` → `global-latency.upstash.io` → `global-us2.upstash.io` → `52.52.x.x`, which is AWS **us-west-1 (N. California)**. It's an Upstash *Global* database, so reads are already served from the nearest replica — there's nothing to configure there.
`vercel.json` used to be `{}`, so functions ran in Vercel's default **`iad1` (Virginia)** and every single round trip crossed the continent. `x-vercel-id: sfo1::iad1::…` on a production response is the tell: request enters at the SF edge, function executes in Virginia.

Measured from SF against production, before any of this: **`/api/goals` took 1.2–1.95s**, not the 335ms the same code showed on localhost. A route doing two round trips (`/api/vacation`) took ~190ms from `iad1` against ~20ms from the west coast, which puts a cross-country round trip at **~65ms against ~9ms**. Round-trip *count* and round-trip *cost* were both multiplying, which is why localhost understated the problem by roughly 4×.

Single-region pinning works on the **hobby** plan (verified on a preview deployment; multi-region needs Pro/Enterprise). If `vercel.json` ever needs to drop it, the equivalent is Project Settings → Functions → Region. **Never let this drift back to a default** — and if the Redis database is ever moved or recreated, re-check its region and move this with it.

### Cold vs warm, and why there's no data cache

The tracker page renders in **46ms warm** (20 commands, 43ms of it Redis, ~4 sequential waves at ~10ms each). The first request after a cold start measures ~190ms instead, and the difference is almost entirely the TLS handshake to Upstash plus JIT — not extra queries. So *cold start*, not query volume, is what's left.

This is why there is **no cross-request cache** and shouldn't be one. It could save at most those 46ms, and it would pay for them with staleness in whether a habit is checked in — the single fact the app exists to record and the one the accountability partner is looking at. The cache that mattered is the request-scoped one in `lib/request-cache.ts`, which removed 42% of the reads with no staleness window at all because it cannot outlive the request.

If cold starts ever do need attacking, the lever is the Edge runtime (near-zero boot, and `@upstash/redis` is fetch-based so it works there) — but that constrains what the routes can import (`app/api/coach` uses the Anthropic SDK), so measure first rather than assuming.

## Tests

Vitest, in `test/`. `.github/workflows/ci.yml` runs lint → typecheck → test → build on every push to `main` and every PR.

**No live Redis.** `test/setup.ts` mocks `@upstash/redis` so every `new Redis(...)` returns the shared in-memory `FakeRedis` from `test/redis-fake.ts`. That fake implements exactly the command surface `lib/kv.ts` uses and preserves the Upstash semantics `kv.ts` depends on (`mget` returns `null` for missing keys, lists are newest-first via `lpush`, and `set` with `nx` returns `null` rather than `"OK"` when the key exists — the nudge ladder's no-double-send guarantee is exactly that return value, so a fake that always said `"OK"` would make a broken dispatch look correct). Add a command to `kv.ts` and the fake needs it too — better a loud failure than a silent `undefined`.

The fake also **records every command it is asked to run**, in `fakeRedis.calls` (as `"<command> <keys>"`), with `countCommands(fn)` as the convenience wrapper.
Round-trip count is the thing that decides how a page feels against a REST Redis, and it's a property no assertion on returned data can catch — an N+1 returns exactly the right answer, just slowly, which is how `GET /api/goals` sat at 135 round trips for as long as it did.
`pipeline().exec()` is recorded as the single round trip it is, keeping the keys it batched, so a test can assert both how many commands went out and what was batched.

**Time is pinned.** The data-layer suites `vi.setSystemTime` to Wed 26 Aug 2026. That date is deliberate: a Wednesday leaves 5 days in the week, which is the only way to construct both the "still winnable" and "already out of reach" weekly-goal cases. Never write a test that depends on the day it happens to run — an earlier throwaway script did, and its "out of reach" case was unconstructible on Mondays, so it failed every Monday for no real reason.

Suites: `week-keys` (ISO week numbering, incl. a 400-day sweep across both year boundaries and a guard pinning already-stored note keys to their labels), `reflection` (every branch of `getReflectionPrompt`, incl. the lookback window - a whole run of misses in one prompt, an older backlog raised but not `required`, and the days it must never ask about: vacation, already-reflected, and before the habit's first check-in - plus what `saveReflection` files where), `graduation` (eligibility, freeze/restore, the untracked guarantees, and the history window ending at `graduatedAt` - including the months-later case that used to read 0%), `nudges` (the pure `getPendingNudges` predicate, plus the escalation schedule: `nudgeSlots`, `dueSlotIndices`, `addMinutes`, `habitCallStart`, `nextCallTime`, `callScript`), `phone` (E.164 canonicalization, incl. the legacy-format inbound match), `nudge-ladder` (the dispatch route end to end), `nudge-inbound` (the Sendblue reply webhook), `notes` (the four-section note round-trip, blank-bullet stripping, and the pre-sections prose surviving an edit), `target-history` (what `recordTargetChange` logs - and what it declines to log - plus the step-line maths in `buildTargetTrend`), `batching` (the round-trip counts of the page-load reads), `tabs` (nav visibility - the pure filter, and that an empty hidden set stores as absent so it can't read back as "hide everything").

`nudge-ladder` is the one suite that drives an API route rather than the data layer.
It replays a whole PST day at the real cron cadence (a POST every 10 simulated minutes, 8am–11pm) with Sendblue and Twilio mocked, and asserts the exact transcript of what went out and when — for its 18:00 habit, `18:00 text`, `19:20 text`, `20:40 text`, `20:50 call`, `21:00 call`, `21:10 call`, `21:40 partner text`.
It also pins the per-habit independence directly: two habits on different clocks run two separate ladders (one being called about while the other is still sending its first text), habits due on the same tick merge into one call, and a habit configured past `DAY_END` still gets both.
The clock is the input under test, so ticks set the system time and let the route read it, rather than passing a time in.
The Twilio mock is a knob for what the *called party* did (`reached`/`missed`/`pending`) rather than a fake of Twilio's HTTP shape, since that outcome is the only thing driving the retry loop.
All three escape hatches are pinned there: replying at all must remove everything remaining including the partner alert, answering the phone must remove the remaining calls and the partner alert, and replaying the same tick ten times must send exactly once.
`nudge-inbound` covers the webhook itself — that the secret gate rejects unverified requests without recording anything, that every shape of reply (a habit name, a bare number, an unmatched "ok") ends the day while an empty message doesn't, and that the confirmation states the full effect.
A `pending` outcome must not consume an attempt — otherwise a slow-to-connect call would silently eat the retries meant to follow it.

`batching` is the regression guard on the work described in [Latency instrumentation](#latency-instrumentation).
It asserts that `getGoalStatuses` doesn't scale its round trips with the habit count, that `settings:vacation` is read exactly once, that the history-length and target-history fan-outs each go out as one pipeline, that a 40-day streak costs under ten commands rather than 41, and that the check-in keys the history grid reads are never re-read by the streak walk.
The bounds are deliberately a little loose - they exist to catch a fan-out being reintroduced, not to pin a number a benign refactor would have to churn - but not vacuous: the real figures are 16 commands for 12 habits (against a bound of 25) and 7 for a 40-day streak (against 10).
Two correctness tests sit alongside them, because a read cache's failure modes are staleness: a check-in written earlier in the same request must be visible to a later read, and nothing may leak between requests.
**Every test in it opens a scope with `runWithCache`**, because that's what a real request does — `withPerf` wraps every route handler and `measure` wraps the server components. Without a scope the cache is a passthrough and the counts would be the un-deduped ones, so a test that forgets it measures the wrong thing.

`scripts/seed-reflection-demo.mts` is *not* a test — it seeds a disposable `reflectdemo` user against live Redis for manual browser QA of the modals, the trophy shelf and the graduated cards in the history tab, which unit tests can't cover. Its `gradold` habit graduated 120 days ago deliberately - a graduated card only misbehaves once graduation falls outside the 91-day grid, so a fixture graduated last week proves nothing. `npx tsx --env-file=.env.local scripts/seed-reflection-demo.mts [clean]`.

## Goals currently tracked (as of June 2026)

**Alan:** Gym-split: HIIT (1x/week), Resistance training (1x/week) · Piano Session (3x/week) · Eye ointment (6x/week) · Stretch (2x/week) · Protein drink (1x/daily) · 7+ hr sleep · Salad · Emotional Check-in (mood/daily)

**Rochisha:** Empty — she sets her own goals from scratch at `/rochisha`.
