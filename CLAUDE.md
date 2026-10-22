# Alan & Rochisha's Accountability App — Claude Code Context

Personal habit tracker. Next.js 14 app router, Upstash Redis (KV), deployed on Vercel. No auth — multi-user by URL path, fully isolated per user.

## ⚠️ Keeping this file a reference, not a changelog

Every session loads this file whole, so its length is a tax on every task. It is **documentation of the system as it stands now**. Git already holds the history; duplicating it here costs context on every future session and slowly makes the file untrustworthy, because a rule and the story of the rule it replaced read the same.

**When you change the app, edit the sentence that is now wrong. Don't append.** If a paragraph describes behaviour that no longer exists, delete it — don't add "(as of October 2026 this now works differently)" underneath it.

| Write this | Not this |
|---|---|
| The rule as it is now, in the present tense | "Until Aug 2026 it did X", "this reverses the original design" |
| *Why* a rule exists, where the why stops someone undoing it | A narrative of the bug that led to it, with dates and who found it |
| A constraint that still binds | A fix that is already in the code and can't regress |
| "`mget` is not free per key, so blocks grow rather than being one fixed width" | "The first attempt used a flat 60 and was a wash, because…" |
| An invariant a test pins | A list of every case that test asserts — read the test |

A rule of thumb: if a sentence would still be true after the next refactor, it belongs here. If it only makes sense as an account of what happened, it belongs in the commit message. Dates, measured before/after numbers, incident write-ups and "we used to…" clauses are all signals you're writing a log.

Two things worth preserving in full, since they are exactly the kind of thing that gets "cleaned up" and then reintroduced: the ⚠️ warnings, and the reason attached to each. Those are load-bearing.

## Stack
- **Frontend:** `app/page.tsx` (landing, lists users) + `app/[user]/page.tsx` (tracker)
- **API routes:** `app/api/` — goals, checkins, history, notes, reflections, mood, settings, vacation, users, meeting-notes, nudge/dispatch, nudge/inbound, push, coach
- **Data layer:** `lib/kv.ts` — all Redis reads/writes. Import from here, never call Redis directly elsewhere.
- **Types:** `lib/types.ts` — `Goal`, `GoalStatus`, `NudgeCandidate`, `WeeklyNote`, `CheckInRecord`, `MoodEntry`
- **Dates:** `lib/dates.ts` — pure `YYYY-MM-DD` arithmetic. Sits below `lib/kv.ts` and `lib/nudges.ts` because both need it and `kv` imports `nudges`.
- **Timezone:** everything PST/PDT (`America/Los_Angeles`); date strings are `YYYY-MM-DD`.

⚠️ **The tracker and history pages are server-rendered, so what they show has two call sites.** `app/[user]/page.tsx` and `app/[user]/history/page.tsx` (and the un-prefixed `/history`) are async server components that read Redis and pass `initialGoals` / `initialHistory` to their client component; those props are optional, and without them the view fetches on mount, which is what client-side navigation and every other view do. `/api/goals`, `/api/vacation` and `/api/history` are what the client re-fetches after a check-in or at midnight — change one and change the other. `getGoalHistories` exists so the history route and the history page can't drift.

## Multi-user architecture

Users are identified by URL path (`/alan`, `/rochisha`). All API routes read `?user=` and pass it through the data layer.

- **`resolveUser(param)`** normalizes it: `"alan"` and `null`/`""` both map to `undefined` (Alan's data has no prefix). Anything else passes through.
- **`k(userId, key)`** namespaces: `userId ? ${userId}:${key} : key`.

Everything is isolated: goals, checkins, history, reflections, mood, notes, journal, settings, nudge dedup flags, push subscriptions.

**Adding a user:** `/admin` (no terminal, no deploy — topics are generated and stored in Redis), or `node scripts/add-user.mjs <id> "<Label>"`. The ntfy topic lives in the `UserRecord` (`checkinTopic`); the checkins route reads it from Redis, falling back to env vars for Alan/Claude/Rochisha.

**Hiding bottom-nav tabs:** `UserRecord.hiddenTabs` (a list of `TabDef.key`s), edited at `/admin`. `lib/tabs.ts` is the single list of hideable tabs, shared by `BottomNav` and the admin toggles; the icons stay in `BottomNav` because they're JSX. Home has no key and can't be hidden. The stored set is the *hidden* one, so an old record reads as "show everything"; `setUserHiddenTabs` stores an empty set as absent and drops non-tab keys.
The list is read in **`app/layout.tsx`** (hence `async`): the nav is a client component in the layout, so this is the only place to fetch it without a client round trip, and fetching it client-side would flash a hidden tab on first paint. The cost is that `/`, `/mood`, `/notes`, `/history`, `/reflections` and `/coach` are dynamic rather than static shells, each paying one `get` of the small `users` key. If that ever needs reversing, the lever is caching the `users` read specifically, not un-hiding tabs.

⚠️ **Hiding a tab is decluttering, not permission.** There's no auth: the route still renders for anyone with the URL, and nothing server-side checks `hiddenTabs`. Same goes for every other "hidden for other users" feature here.

**Habit-completion push** (so the partner sees a check-in): a Web Push to every device of the user whose phone is this user's `partnerPhone`.
Only a live check-in sends one.
A `date` on the request is a history backfill and stays quiet.
The tag is one per habit and is not `nudge`, and the service worker shows that tag, so a check-in and a pending-habit reminder do not replace each other.
Apple's Web Push topic is at most 32 characters, so the tag is capped there.
A longer one is rejected and the notification never arrives.
It stays deliverable for 12 hours, because a morning check-in is still news that evening.
Tapping it opens the checker's tracker.
A push that reaches no device falls back to that user's ntfy topic (`checkinTopic`, else `NTFY_TOPIC` / `NTFY_{USER}_TOPIC`).
A push that lands does not also ntfy, or anyone with both would hear it twice.
The check-in is saved before either send, and neither failure changes the response.
There is no in-app nudge modal.
Pending habits are surfaced entirely by the ladder below.

## Escalating nudges (Sendblue + Web Push + Twilio + QStash)

Any user with a `phone` set climbs a five-step ladder each day, **per habit**, until they check in. A browser subscription alone runs the reminder half (steps 1-3) when push is configured. Calls and the partner text still require the phone. `lib/nudges.ts` owns the whole schedule and is pure — clock, weekday and habit list are passed in, so nothing else computes when a step is due.

| Step | When | What |
|------|------|------|
| 1-3 | `nudgeTime`, then evenly spread toward `DAY_END`, never closer than `MIN_SLOT_GAP_MIN` (20 min) | Text via Sendblue, and the same list as a Web Push notification |
| 4 | `habitCallStart` — `ESCALATION_DELAY_MIN` (10 min) after *that habit's* last text — retried every `CALL_RETRY_MIN` (10 min), `MAX_CALL_ATTEMPTS` (3) | Call via Twilio |
| 5 | `PARTNER_ALERT_DELAY_MIN` (30 min) after the day's last call attempt, once no habit has an attempt left | Text to `partnerPhone` |

Steps 1–4 are per habit; only step 5 is user-level. `nudgeSlots(nudgeTime)` divides `nudgeTime → DAY_END` into thirds, so every habit gets exactly three texts before the call: 9am lands 9:00/13:20/17:40, 9pm lands 21:00/21:20/21:40. `nudgeTime` defaults to `"21:00"`.

`getPendingNudges` is the single source of truth for "is this habit pending", and gates a habit out until its own `nudgeTime` has passed. Vacation-paused and graduated habits are excluded. `getNudgeCandidates(date, userId)` is a deliberately narrow alternative to `getGoalStatuses` — the ladder needs two counts per habit, not a streak walk and a reflection prompt.

Two consequences of per-habit scheduling:
- **Texts and calls don't exclude each other.** There is no user-level cutoff into a "call phase"; a habit can be sending its first text on the tick another is being called about. (Pinned by regression tests — a cutoff silently starved any habit nudging after it.)
- **Habits due on the same tick share one call.** `dueCalls` is claimed per habit but placed as a single call naming all of them, since dialling twice in one tick gets a busy signal.
- **A bad night is a lot of calls** — four habits on four clocks is up to twelve. Answering any one ends *those* habits' ladders.

### Late habits and the nudge day

**`nudgeTime` is uncapped, and a ladder belongs to the nudge day it started on, not the calendar.** Past 21:00 there's no span left to divide, so `nudgeSlots` falls back to `MIN_SLOT_GAP_MIN` spacing and runs past midnight: 22:30 texts 22:30/22:50/23:10, calls 23:20/23:30/23:40, alerts the partner at 00:10; 23:30 finishes at 01:10. The floor equals a 21:00 habit's spacing, so nothing at or before 21:00 is affected.

Three load-bearing pieces:
- **`lib/nudges.ts` counts minutes from the nudge day's midnight and lets the count exceed 1440.** As `"HH:MM"` strings a post-midnight time sorts *before* everything else in its own ladder and `now >= deadline` silently never fires. `CallAttempt.at` and `nudge:escalated:{date}` store minutes for the same reason; `formatHHMM` is for logs only.
- **`nudgeAnchors(nowMin, today)`** returns today, plus yesterday while `nowMin < CARRYOVER_WINDOW_MIN` (3h) — the tick is asked twice rather than every step learning about dates. `crossesMidnight(nudgeTime)` narrows the carryover pass to habits whose ladder actually overhangs; without it every habit missed yesterday reopens at 00:00 with all slots past and immediately owes a *second* partner alert. Shared by the dispatch tick and the inbound handler, which must agree on "currently nudging".
- **Nudge claims outlive midnight** (`nudgeClaimTtl` = midnight + `CARRYOVER_WINDOW_MIN`), or a running ladder loses its own "already sent" record mid-flight and restarts from slot 0.

### Replying: snooze until a time, or pause for the day

**Two commands, told apart by whether there's a clock time** — a time means "later today", no time means "not today". `lib/snooze.ts` owns the grammar; `parseNudgeReply` returns one, the other, or `null` for anything else ("ok", a bare number, a time with no numbers), which leaves the ladder running and resends the instructions. `pause 1 until 4pm` reads as a snooze.

| Reply | Means |
|---|---|
| `1 2 until 15:30` | Delay those habits to that time. Ladder resumes afterwards, partner alert included. |
| `pause 1`, or bare `pause` | Those habits are done for the day — the same full exit as answering the phone. |

**A pause writes the same `nudge:muted:{goalId}:{date}` that answering the phone does**: no further texts, no call, **no partner alert**. It exists because a snooze needs a time the user intends to act on, and "not today, on purpose" has none — without it a rest day is indistinguishable from ignoring the app. Bare `pause` (also `skip`, and padding like `pause all`) means every habit nudging at that moment; with numbers, only those. **This is a text-reachable exit from the partner alert** — a deliberate trade, Alan's call.

**A snooze holds the named habits until a clock time**, stored as `nudge:snoozed-until:{goalId}:{date}` in minutes from the nudge day's midnight. One reply can give several habits different times (`1 until 15:30 and 2 until 4pm`); `3:30` with no am/pm means whichever reading comes next; a later reply overwrites. During the hold: no texts, no calls, partner alert waits. Text slots passing during the hold are claimed without sending so they don't all fire at once; calls wait rather than being spent.

**A hold is clamped to `maxSnoozeUntil(nudgeTime)`, because a snooze no tick can clear is a silent mute.** `snoozeHold` is the only writer and pulls a request back to the cap rather than refusing it. The cap is the nudge day's horizon less `LADDER_TAIL_MIN` (50 min) and one `CALL_RETRY_MIN` of slack (calls land on the tick at or after the hold expires, not on the minute). That horizon is midnight for a habit whose ladder doesn't overhang (23:00 for anything at or before 22:19) and midnight + `CARRYOVER_WINDOW_MIN` for one that does (02:00) — exactly the window `nudgeAnchors` ticks. It's always later than the habit's own `nudgeTime`, so clamping can never make a habit unsnoozeable. A reply arriving after the cap writes no hold and says so rather than confirming a time in the past.

**Only habits nudging right now can be snoozed or paused.** A number whose nudge time hasn't come is left alone, and so is everything a bare `pause` doesn't reach — a reply can only be about a question already asked.

Confirmations: a snooze names each habit and **the time actually written**, so a clamped hold adds `That's as late as tonight's nudges run.` (otherwise 01:00 → 23:00 reads as the app mishearing). A pause names every habit it reached (`⏸️ Paused for today: 🥗 Salad. It's back tomorrow.`), since that's the only place a user learns it took something they didn't mean. Both share `replyTail` for the unmatched-numbers and "anything you left out" sentences.

### Pieces

- **`app/api/nudge/dispatch/route.ts`** — the tick. Requires `x-nudge-secret` matching `NUDGE_DISPATCH_SECRET`; there is no unauthenticated path. Scheduled by an **Upstash QStash schedule** (Vercel Hobby cron can't run more than once/day): `scd_6rvyNmFdwb26ghYXDmXWTpxUzcJc`, cron `*/10 * * * *`, round the clock, POSTing to `https://accountability-azure.vercel.app/api/nudge/dispatch` with the secret as an `Upstash-Forward-x-nudge-secret` header. Manage via the QStash token from `upstash qstash list` against `https://qstash.upstash.io/v2/schedules`; delivery history at `/v2/events`.
  ⚠️ **The schedule must cover every hour a ladder can run in**, and tick at least as often as `MIN_SLOT_GAP_MIN` (20 min). If it's ever narrowed, cap `nudgeTime` in the habit form to match — otherwise late habits go quiet with no error anywhere. Keep the scheduler somewhere whose credentials this repo's operators actually hold.
  `runLadder` runs all five steps for one user against one `NudgeAnchor`, called once per anchor — an overnight ladder is the same ladder asked about a day that started yesterday, not a special case.
- **`lib/call.ts`** — `placeCall` is the only thing that talks to a voice provider (the seam `lib/sendblue.ts` gives texts). Inline TwiML (one-way call, so no public webhook to authenticate), `Polly.Matthew`, `loop="2"`, habit names spoken without emoji. `callScript` in `lib/nudges.ts` builds the text. `isCallConfigured()` gates on the Twilio env vars, so an unconfigured deployment just stops after step 3.
  ⚠️ **Twilio reports voicemail as `completed`, exactly like a human answering** — which would stop the retry loop on the one case it exists for. Two things separate them: `Timeout: 20` (shorter than the ~25-30s before carriers divert, so an unanswered call rings out to an honest `no-answer`) and `MachineDetection: "Enable"` (populates `answered_by`). `getCallOutcome(sid)` collapses status + `answered_by` into `reached`/`missed`/`pending`, polled on the *following* tick rather than pushed to a callback. `unknown` and absent `answered_by` both count as `reached` — failed detection isn't evidence of a machine. A `pending` outcome must not consume an attempt.
- **`app/api/nudge/inbound/route.ts`** — Sendblue's webhook target, registered via `POST https://api.sendblue.com/api/account/webhooks` with a chosen secret, which must be echoed back (checked against `sb-webhook-secret`/`sb-signing-secret` headers or a `secret` body field — their docs don't pin down which, so all are checked; unverified requests 401). Sendblue has no reply-to/thread field, so the clock is the only way to know which habits a reply is about. It walks the same `nudgeAnchors` as the tick, because just after midnight the text being replied to may belong to yesterday's ladder and the hold or mute must be written under *that* day's key. A well-formed command with nothing pending is told so outright rather than handed the generic hint.
- **`Goal.nudgeNumber`** — stable 1..N per user, shown in texts ("2. 🏋️ Gym") so a reply like "2" always means the same habit. `renumberGoals()` reassigns compactly on add/delete (from `app/api/goals/route.ts`); `getGoals()` backfills it. It tracks storage order, not drag-reordered display position, and is deliberately **not** renumbered on graduation so a number survives a round trip to the shelf.
- **Every step claims its slot before sending** (`SET NX EX`, all expiring at `nudgeClaimTtl`), so overlapping or retried dispatches can never double-send: `claimNudgeSlot` → `nudge:sent:{goalId}:{date}:{slot}`, `claimEscalation` → `nudge:escalated:{date}`, `claimCallAttempt` → `nudge:call:{goalId}:{date}:{attempt}` (holds `{at, sid}`, sid written back once Twilio accepts so the next tick can poll it; merged calls share a sid), `claimPartnerAlert` → `nudge:partner-alerted:{date}`. `date` is the **nudge day** — after midnight, yesterday.
- **`dueSlotIndices` returns every passed slot**, so an outage burns the slots it slept through rather than replaying them one per tick and crowding the call they precede. **`nextCallTime` does the opposite**, scheduling each retry off when the previous call actually went out — a missed call is a chance to reach someone that's still worth taking a tick late. The asymmetry is intentional.
- `lib/sendblue.ts`'s `sendText` is the only caller of the Sendblue send API.

⚠️ **Never put a carrier opt-out keyword in an outbound message.** `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` are intercepted by the carrier *ahead of* Sendblue on SMS and permanently block every future message from that sender — transactional included — while the inbound webhook never fires. The failure is silent and backwards: no mute is recorded, so the ladder keeps calling and alerting the partner about texts that can't be delivered, and undoing it needs the user to text `START` to their carrier. Sendblue additionally auto-detects `stop, unsubscribe, cancel, opt out, revoke, end, quit` (and `start`), so this bites on iMessage too, and there is **no API to query opt-out state**. The outbound line is `Snooze with the numbers and a time, e.g. "1 2 until 15:30", or "pause 1" to skip it today.` — it names the shapes of a reply rather than inviting a free-form one, because a free-form invitation is an invitation to improvise "stop". **Offering "pause" is part of that defence**: a user who means to skip today needs a word for it, and left to improvise reaches for exactly the reserved keywords. A test in `nudge-ladder` word-boundary-matches every outbound message against the reserved list.

Env vars: `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`, `SENDBLUE_WEBHOOK_SECRET`, `NUDGE_DISPATCH_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

**Phone numbers:** `normalizePhone` canonicalizes to E.164 on write and `findUserByPhone` normalizes both sides. Load-bearing for inbound only — Sendblue and Twilio parse loose forms on *send*, but report an inbound sender in strict E.164, so a formatted stored number matches no user and silently drops every reply.

### Web Push

The same three reminders also go out as a notification, to every browser that has turned them on from the home screen. `lib/web-push.ts` is the only sender. Subscriptions are a list at `push:subscriptions`, one entry per device, replaced in place when the same device registers again. Saving one claims the endpoint and removes it from every other user's list, so a shared browser follows whoever just tapped Turn on. The home screen matches its own subscription locally and hides the control once this device is on. It does not re-post on each visit, or opening someone else's tracker would take the device. A subscription the push service answers with 404 or 410 is dropped. Any other failure is logged by status only (the endpoint is a capability URL) and does not abort the ladder. One notification lists every habit that just claimed a slot, and a newer one replaces an undelivered older one (topic `nudge`).
The notification does not carry the text-reply instructions.
A check-in is not part of that collapse.
It has its own per-habit topic, and the worker shows the payload's tag instead of `nudge`, so the two stay on the lock screen together.

iOS delivers Web Push only to a site added to the Home Screen, so the manifest is `display: standalone` and the home screen tells an in-Safari iPhone to add it before offering the button. The manifest start path is the person whose page is open (`/rochisha`, or `/alan` for the unprefixed tabs). Tapping the notification opens that person's tracker. Endpoints are stored only when the host is Apple, Google, Mozilla, or Windows push. With `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, or `VAPID_SUBJECT` unset (`mailto:` or `https://`), the ladder skips push and the home screen hides the control. Generate with `npx web-push generate-vapid-keys`. The worker at `public/sw.js` handles `push` and `notificationclick` only, and is served with `Cache-Control: max-age=0, must-revalidate`. It does not cache pages, so a reload is a new version.

## Data model

| Key | Shape |
|---|---|
| `goals` | JSON array of `Goal` |
| `checkin:{goalId}:{YYYY-MM-DD}` | count. Weekly habits are tracked daily and aggregated — there are no week-keyed checkin records. |
| `reflection:{goalId}:{YYYY-MM-DD}` | `{ text, savedAt }`, always date-keyed |
| `mood:{YYYY-MM-DD}` | list of `MoodEntry` JSON. Also increments `checkin:emotional-checkin:{date}`. |
| `target-history:{goalId}` | list of `TargetChange` JSON, `rpush`ed chronologically |
| `note:{YYYY-Www}` | `WeeklyNote` |
| `settings:vacation` | list of `VacationWindow` |
| `coach:chat` | list of `CoachMessage` |
| `push:subscriptions` | list of `{ endpoint, keys, expirationTime }`, one per device, capped at 10 |

All prefixed with `{userId}:` for everyone but Alan.

**Reflections are keyed by the day they're *about*.** `reflectionDateKeys` writes a **daily** habit's text to every missed day the prompt just named (falling back to yesterday), so none is raised again — `getUnreflectedMissedDays` drops days that already carry one, so filing against the run's last day alone would bring the rest back tomorrow. A **weekly** habit's goes under the one day its prompt named, falling back to the day it was written.

**Weekly notes** are a headline plus three `string[]` sections: `wentWell`, `didntGoWell`, `actionItems`. `notes` (prose body) and `changes` (progress log) are retired — optional, never written, still rendered by `NoteCard` so older notes read back whole, and passed back through by `NoteForm` on edit so editing doesn't blank them. A few pre-sections bodies type their own `What went well` headings *inside* the prose, which renders as a wall of text — that's the tell for one still worth converting. When searching for them, glob `*note:*`, not `note:*`, or the prefixed namespaces are silently missed.

Notes are keyed by **ISO-8601 week** (Monday-start; week 1 contains Jan 4; the ISO year leads, so Mon Dec 29 2025 is `2026-W01`). `getWeekKey` is the only thing that should compute one — `NotesView`'s client-side `weekKeyForDate` mirrors it and must stay in step. `legacyWeekKey` exists solely to read two pre-existing `checkin:gym:2026-W1x` keys via the fallback in `getWeeklyDaysCompleted`.

**A note can only be *started* for last week or earlier** — it's the write-up of a meeting about a week that has finished. The picker offers last week and two weeks ago outright, plus a date field capped at last week's Monday that snaps any day back to its Monday. `getLatestNoteWeekKey` is the server half (week keys sort lexicographically, so it's a string comparison), and it gates **creation only** — an existing note stays editable whatever week it's filed under.

**The notes tab loads the newest three weeks** and offers "load more" in threes (`GET /api/notes?limit=`, capped at 52; the response is `{ notes, total }`). `getAllWeeklyNotes` sorts the **keys** descending *before* slicing — `kv.keys` returns arbitrary order, so slicing first hands back random weeks. A week reached through the date selector can be older than the page has loaded, so `handlePickWeek` fetches it alone and uses the presence of `updatedAt` to tell a stored note from the API's empty shell; otherwise picking an old week opens a blank form that overwrites it on save. Such a note is edited above the list, since it has no card to turn into one.

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
  nudgeTime?: string;   // "HH:MM" PST; gates when a habit enters the nudge rotation
  nudgeEnabled?: boolean; // opt out of nudging, default true
  nudgeNumber?: number; // stable per-user 1..N id used in nudge texts ("reply 2")
  graduatedAt?: string;   // YYYY-MM-DD; presence = graduated, i.e. no longer tracked at all
  graduatedRun?: number;  // run frozen at graduation: days (daily) or weeks (weekly)
  graduationSnoozedUntil?: string; // YYYY-MM-DD; "not yet" on the graduation offer
}
```

## Key behaviors

- **Goal ordering:** drag-and-drop via `@dnd-kit`; done goals sink to the bottom. Persisted via `PATCH /api/goals` with `{ orderedIds }`.
- **Pull to refresh:** pulling down from the top of a page reloads it. The installed app has no reload button, and moving between tabs keeps the version already open, so this is how a new version arrives without quitting. A pull that starts on a button, a link, a field, or an open sheet is left alone, and so is a sideways drag. The home-screen icon is a copy the phone made when the app was added, and this reload does not replace it.
- **Backfill:** clicking a missed (gray) history cell logs it for that date — `POST /api/checkins` accepts `{ goalId, date }`.
- **Streak units:** the history card labels the streak "day streak" or "week streak" per `goal.frequency`; a bare "🔥 9" over a three-month grid reads as weeks.
- **Weekly streaks** are counted in weeks. `getWeeklyStreak()` walks back 52.

### Reflection prompt

`getReflectionPrompt()` is the single source of truth for whether to ask, why, and whether the user can decline. It returns a `ReflectionPrompt` on `GoalStatus.reflection` or `null`; the client also requires `todayCount === 0`, so a habit prompts at most once a day.

**Daily habits** prompt with `missed-day`, carrying **every** unreflected missed day in the last `REFLECTION_LOOKBACK_DAYS` (14), oldest first. Asking only about yesterday left two kinds of miss permanently unreachable, since the prompt fires on the *next check-in*: a day in the middle of a run, and a day whose next check-in came from the history grid's backfill. `getUnreflectedMissedDays` excludes vacation days, days that already carry a reflection (re-asking overwrites the answer), and days before the habit's first check-in (read off the tail of `history:{goalId}` — otherwise a habit added yesterday opens with a fortnight of misses it wasn't around for). The window is bounded because a reflection written in October about a day in June isn't a reflection, and a dismissed prompt would otherwise re-ask forever.

**Weekly habits are judged against the whole week.** A 3x/week habit skipped on Tuesday with four days open is not behind and is asked nothing. They prompt only when the days still open no longer outnumber the days still needed (`week-behind`), or when nothing is logged this week and last week closed below target (`week-missed`, once per week). A knife's edge of exactly one day is exempt — the prompt gates a check-in, and that check-in *is* the day still needed. Vacation-paused days drop out of the days remaining and prorate the target down. A day asked and answered settles its week: both weekly reasons stand down while the day they'd name already carries a reflection, and a *new* miss reopens the question about the new day.

**Weekly prompts name one day, not the week** — "Sunday you missed this", the way a daily prompt does, because a week isn't a thing a person can account for. `lastMissedWeekDay` picks the most recent expected-and-unfilled day. **`nudgeDays` is preferred where set** — it's the closest a weekly habit has to a schedule — but is a fallback rather than a rule, since it's a *reminder* schedule, not a contract (several habits leave it empty; Piano asks 5x/week while nudging twice). Today is never named, nor a paused day, which leaves `date: null` genuinely reachable; the modal keeps count wording for that case.

**`required`** decides whether the reflection can be waved away. A period that's already lost — yesterday, a closed-out week, a week now unreachable — is required; a knife's-edge week still winnable isn't. A daily prompt is required only when **yesterday** is among the days it names: an older backlog is raised but not charged for, since a toll the user can't clear today is how a prompt becomes something people dismiss. A required prompt drops the skip link and needs `MIN_REFLECTION_CHARS` (15) before the check-in button enables; ✕ and backdrop still close it, but closing does **not** check the habit in. This is UX friction, not enforcement — `POST /api/checkins` has no server-side gate.

### Reflections in the history grid

A cell's **fill** is the outcome (green done, gray missed, sky vacation); an **amber inset ring** means a reflection was *written* that day, named in the tooltip.

**`getReflectionsByWrittenDay` keys the history payload by `savedAt`, not by the storage key.** A reflection is stored against the day it's *about* so the prompt can't re-ask, but that's not where a person looks for it — they wrote it Sunday morning about Saturday's miss. Two consequences: a ringed cell is usually **green** (the modal saves seconds before the check-in it was gating), and one sitting rings **one** day (a daily reflection filed across a run of misses shares a single `savedAt`). Where two share a written day, the later `savedAt` wins. The re-keying reads `REFLECTION_LOOKBACK_DAYS` further back than the 91-day window — one wider `mget`, not another round trip — or a reflection written on the window's first day about an earlier miss is missed.

Fill and ring are separate because a reflection is not evidence of a miss. Painting a missed cell amber instead of gray drops every reflection a weekly habit collects on a day it completed, and costs "missed" its own colour. The backfill confirmation reads the same map.

### Emotional Check-in

`id: "emotional-checkin"`, `type: "mood"`. Opens the mood wheel; "Log another" instead of "undo" when done; no position pin.

`MoodModal` opens on a `REFLECT_SECONDS` (5) countdown ("Reflect on your whole day.") so an entry is a read on the day rather than a reflex tap on the last ten minutes. The wheel isn't mounted until the countdown ends — its slide-to-explore tutorial should play when the user arrives at it — and the countdown panel is height-matched to the wheel step so the sheet doesn't jump. **There is no 😐 Neutral, and don't add one**: it's the one option that records nothing, and sitting mid-wheel it's the easiest thing to land on, so it throws away the deliberation the countdown just bought. `TUT_STEPS` derives from `WHEEL_EMOTIONS.length` so the tutorial can't fall out of step. No skip; ✕ and backdrop close outright.

### Target history

Every change to a habit's `frequency`/`targetCount` is appended to `target-history:{goalId}` and drawn as a step chart under its history grid. `recordTargetChange` is called from `POST /api/goals` on every write and no-ops unless the target moved.

**It is what every past period is scored against.** A week is judged against the target the habit had *that week*: `targetAsOf(changes, date, goal)` walks to the last record on or before a date, and `targetOn` layers a vacation week's planned target on top. Both streak walks, `buildHistory`'s done/missed fill, graduation and the weekly reflection prompt all resolve through it — otherwise raising a target breaks a live streak and lowering one invents weeks that were never met. `primeTargetHistories` is therefore in `getGoalStatuses`'s priming wave, not just the history page's.

Two things it is **not**: nothing reads it to decide what to nudge about (the ladder uses the live target), and a `frequency` change isn't converted — a daily↔weekly reshape ends the streak rather than being rescored, which is what `streakOffset` covers for the one historical reshape.

`lib/target-history.ts` is the pure part: `weeklyEquivalent` puts daily and weekly targets on one per-week axis (6x/week → daily is a step **up**, 6 → 7, which raw `targetCount` would draw as a collapse to 1), and `buildTargetTrend` collapses records into segments, returning `null` when nothing moved. Several edits on one day collapse to the last. A habit predating the feature has no record of what it changed *from*, so the first change writes a `backfilled` record dated when we noticed — which is why the chart draws the run before it as a dashed, open-ended line.

### Graduation

A habit the user has decided is automatic. `Goal.graduatedAt` is the flag — its presence *is* graduated — and `graduatedRun` freezes the run earned at that moment. `isGraduated()` is the single definition.

Graduating **stops tracking entirely**: no check-ins (`addCheckIn` throws `GraduatedGoalError` → 409), no nudges, no reflection prompts, and no streak recomputation (`getGoalStatuses` short-circuits to the frozen values; `/api/history` reports `graduatedRun`). The habit moves to a collapsible trophy shelf of emoji medallions at the top of the home screen (`TrophyShelf`); "start tracking again" is the only way back.

**Offering it:** `GoalStatus.canGraduate` fires once the run reaches `GRADUATION_PERIODS` (4) consecutive periods at target — 28 days or 4 weeks. Mood goals are never eligible. "not yet" sets `graduationSnoozedUntil` 14 days out; un-graduating sets it too. All three actions go through `PATCH /api/goals` with `{ goalId, graduation: "graduate" | "ungraduate" | "snooze" }` (the same PATCH still handles `{ orderedIds }`).

**In the history tab a graduated card is frozen, not rolling forward.** `goalHistoryLabels` ends its 91-day window at `graduatedAt`, and the target chart gets the same end date, so the card reads as the run that earned it. This follows from nothing being recordable after graduation: with a rolling window every post-graduation cell is one that can never be filled, so a habit graduated more than 91 days ago renders as a blank grid. The card also demotes into a collapsible "🏆 Graduated · N" section at the bottom (`GraduatedSection`), collapsed by default where the shelf is open. Its backfill handler is withheld (a tap that can only return 409) and its streak pill reads "final run".

### Vacation mode

Per-user, per-habit, **per-week plan**: `VacationWindow { startDate, endDate, goalIds, plan }` at `settings:vacation`.

**Planned in advance, habit by habit and week by week, with nothing prefilled.** `VacationWeekPlan` carries one `VacationGoalPlan` (`{ targetCount, nudgeTime?, nudgeDays?, nudgeEnabled? }`) per habit per ISO week the trip touches; `POST /api/vacation` rejects any missing week or undecided habit by name. `targetCount: 0` is how "not this week" is said, and `startVacation` derives the legacy `goalIds` from exactly those zeros so a window still reads as "these habits are paused" to anything that only knows the old shape (`isVacationDay` falls back to `goalIds` for pre-planning windows).

A plain list of habits to pause can't express the middle — "the gym's off but I'm keeping the stretching", "three piano sessions instead of five" — which makes a trip all-or-nothing per habit and makes ticking everything the path of least resistance. `app/components/VacationPlanner.tsx` offers Skip / keep-the-current-target / a custom number per habit per week, rings undecided rows amber, disables Save until none are left, and hides an optional per-week nudge override behind each kept habit.

**A planned week is scored at the target the user chose**, through the same `targetOn` resolver as a target change. A week planned off is neutral in both streak walks — it neither counts nor breaks — and a kept week that missed its own reduced target still breaks. `getNudgeCandidates` drops a habit planned off and applies the week's `nudgeTime`/`nudgeDays`/`nudgeEnabled` to one that's kept, which is why the `nudgeEnabled === false` check sits at the top of `getPendingNudges` rather than in its daily branch — a vacation week has to be able to silence a weekly habit too.

`weeksInRange` / `mondayOfWeekKey` in `lib/dates.ts` are what the planner and the route agree on for "which weeks does this trip touch". A window can be scheduled for a future `startDate`: `getActiveVacation` only returns it once `startDate <= today`, `getUpcomingVacation` surfaces it before then. `endVacationNow` trims an active window to end yesterday (preserving vacation-day history) or deletes a not-yet-started one outright. `startVacation` replaces any window that hasn't fully ended — only one is in flight at a time.

## Writing a meeting up from its recording (Fathom)

"🎙️ Write up a recorded meeting" at the bottom of the notes tab takes a Fathom share link and writes **last week's note for both Alan and Claude at once**.

- **`lib/fathom.ts`** — `fetchFathomTranscript(shareUrl)`. A Fathom share page is an Inertia.js app, so the page state is one HTML-escaped JSON blob in a `data-page` attribute; `props.copyTranscriptUrl` is the URL behind their own "copy transcript" button and already carries the share token. It returns `{ html, plain_text }`; use `plain_text` (the same transcript without per-turn timestamp links, ~5× fewer tokens), with the HTML strip as a fallback since that field is theirs, not ours. **The token is the entire authorization** — the endpoint without it answers 401 — so there's no API key to hold. The flip side is that this is a scrape: their markup changing breaks it, and a revoked link fails at the fetch. `isFathomShareUrl` accepts only `https://fathom.video/share/<token>`.
- **`lib/meeting-notes.ts`** — `summarizeMeeting(transcript, people)` calls `claude-opus-5` with adaptive thinking at `effort: "medium"` and a `json_schema` structured output, returning `{ headline, wentWell, didntGoWell, actionItems }` per person. Streamed, with `maxDuration = 120` on the route, because a half-hour transcript summarized twice doesn't fit a default function lifetime; `medium` is the same tradeoff, since the hard part is obeying the action-item rule rather than reasoning to an answer.
  **The action-item rule is the whole reason this isn't just "summarize the call".** An action item must map onto a habit the person actually tracks; everything else a call covers — favours, side projects, logistics — can colour the headline but can't become one, or the note stops being the record of a habit review. It must also be specific and new ("keep going to the gym" isn't one). Anything about the app itself is filed under `claude`, whoever raised it.
  **Each person's habit list is passed in** rather than scraped from their history page — same list `getGoals` holds, minus graduated — and that's what makes the rule checkable. The reply is re-keyed by `userId` and one summary returned per person asked about, so a model that drops someone or invents a third id can't write into a namespace nobody reads.
- **`app/api/meeting-notes/route.ts`** — `POST { url }`. The pair is hardcoded (`["alan", "claude"]`): it's their meeting, and letting the caller name namespaces would only be a way to write into the wrong one. No preview step — the note is editable from its card the moment it lands. Failures come back as a readable message with a 502, since a dead link or a transcript-less call are things the person who pasted the link can act on.
- The button is hidden for other users (`MEETING_PAIR` in `NotesView.tsx`) — decluttering, not permission.
- Env var: `ANTHROPIC_API_KEY` (shared with the coach).

## Coach chat (digital twin)

Per-user chat (`/[user]/coach`, `app/components/CoachView.tsx`) with an LLM persona grounded in transcripts of a personal-development audio program (owned by Alan, ingested for strictly personal use — not distributed).

- **`lib/vector.ts`** — `searchTranscripts(query, topK)` against Upstash Vector's hosted-embedding `data` field (no separate embeddings step). The index is **shared with the unrelated `provenance-mcp` project** (same credentials in both repos' `.env.local`); this app's chunks live in the `coach-transcripts` namespace so they never collide with provenance-mcp's vectors in the default one.
- **`lib/coach.ts`** — builds the system prompt (persona + retrieved excerpts) and streams a reply via `@anthropic-ai/sdk` (`claude-sonnet-5`). `CITATION_INSTRUCTION` asks for an inline `(Day — Session)` wherever a point is actually drawn from an excerpt, and for no citation when speaking from general principles. `renderBold()` in `CoachView.tsx` renders the `**bold**` the replies use for headers.
- **`app/api/coach/route.ts`** — `GET` returns history; `POST { message, attachments? }` saves the user message, retrieves excerpts and streams the reply, persisting it once the stream ends. **Retrieval is context-aware**: the query is the prior turn's text + the new message, so short follow-ups ("tell me more") retrieve the topic under discussion rather than their own semantically empty text.
- **Attachments** — text files, images or PDFs on a single message, read client-side via `FileReader`. **One-off context for that turn only** — never persisted as files or indexed. Text attachments are appended into the persisted message text (so they stay in later turns' history); images/PDFs go as base64 blocks for that turn with only an `[Attached image: ...]` marker persisted. Caps: 5 attachments, 50k chars/text file, ~10MB/binary.
- **Storage** — `CoachMessage`/`getCoachMessages`/`addCoachMessage` in `lib/kv.ts`, `rpush` to `coach:chat` / `{userId}:coach:chat`.
- Env vars: `UPSTASH_VECTOR_REST_URL`, `UPSTASH_VECTOR_REST_TOKEN`, `ANTHROPIC_API_KEY`.

**One-off scripts** (manual, idempotent, safe to re-run): `scripts/ingest-transcripts.mjs <folder>` chunks `Day N .../*.txt` transcripts (~3000 chars, ~300 overlap) into the `coach-transcripts` namespace with deterministic ids. `scripts/backfill-coach-citations.mjs [user]` adds citations to replies that predate `CITATION_INSTRUCTION`, re-deriving each query, re-running retrieval, and asking Claude to insert markers into the *existing* text without rewording; it skips replies that already have one and skips rather than guesses when nothing is excerpt-grounded.

## Migrations (run on every `getGoals()` call)

Add new ones at the bottom of the migration block in `getGoals()`, before `if (changed) await kv.set("goals", goals)`. That block is **Alan-only** (`!userId`); the `nudgeNumber` backfill right after it runs for everyone.

Current: sleep goal added if missing · `emotional-checkin` added if missing · eye ointment 5 → 6 · salad 6x/week → daily, preserving its streak as `streakOffset`.

## Writing a note straight to Redis

Useful when you want one to exist without going through the form. Work out the ISO week key first (`2026-W26` = week of Mon Jun 22).

```bash
curl -s -X POST "$UPSTASH_REDIS_REST_URL/set/note:2026-W26" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(node -e "
process.stdout.write(JSON.stringify({
  week: '2026-W26',
  weekLabel: 'Week of Jun 22',
  headline: 'Short headline here',
  wentWell: ['...'],        // one string per bullet
  didntGoWell: ['...'],
  actionItems: ['...'],
  updatedAt: Date.now(),
}));
")"
```

⚠️ **Use `process.stdout.write(JSON.stringify(note))`, never `console.log(JSON.stringify(JSON.stringify(note)))`.** Double-encoding stores a string-of-a-string, and the card then renders with no label, no headline and no sections. Verify the result is `dict`, not `str`:

```bash
curl -s "$UPSTASH_REDIS_REST_URL/get/note:2026-W26" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" | \
  python3 -c "import sys,json; v=json.loads(json.load(sys.stdin)['result']); print(type(v).__name__, list(v.keys()))"
```

## Dev

```bash
nvm use              # node 24.21.0, per .nvmrc — the version CI runs
npm run dev          # localhost:3000
npm run verify       # the full CI sequence — run this before pushing
npm run verify:quick # lint + typecheck + test, for the inner loop
npm test             # vitest run
npm run deploy       # git push (Vercel deploys from main)
```
Env vars: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` in `.env.local`.

**Local/CI parity.** `npm run verify` mirrors `.github/workflows/ci.yml` step for step — env check, lock check, lint, typecheck, test, build — so a green verify means a green CI. Change one and change the other.

The toolchain is pinned in **`.nvmrc` (24.21.0)**, read by CI via `node-version-file` and locally by `nvm use`. npm isn't pinned separately — it's whatever that node ships, so matching node matches both. `engines.node` is `24.x` because Vercel selects only a major; `engines.npm` records what `.nvmrc` ships. `scripts/check-env.mjs` fails when the running toolchain isn't that pair (`SKIP_ENV_CHECK=1` overrides).

⚠️ **This isn't ceremony.** npm versions disagree about which optional peer deps belong in a lock file, so a `package-lock.json` written by one npm can be **rejected outright** by another (`Missing: @emnapi/core from lock file`) and `npm ci` dies before lint, test or build runs — reproducible nowhere but CI. `npm run check-lock` (`npm ci --dry-run`) catches a desynced lock in about a second, which is the one failure a passing local test suite says nothing about.

## Latency instrumentation

Upstash is REST: every command is its own HTTPS round trip, no pipelining. **What decides whether a page feels instant is almost entirely how many commands a request issues** — a number that's invisible in the code, being the product of a per-goal loop and a per-day loop several frames apart. `lib/perf.ts` counts it.

- **`instrumentRedis`** wraps the client in `lib/kv.ts`: every command counted and timed against the current request, and the keys of every *read* recorded so re-reads are visible.
- **`span(name, fn)`** times a named block. Spans run concurrently, so summed span time exceeds wall clock — the count and per-span total are what's meaningful.
- **`withPerf(label, handler)`** wraps every `app/api/*/route.ts` handler: one log line per request plus `Server-Timing`, so the numbers appear in the browser network panel next to the request. `measure()` is the same for server components.
- **`lib/client-perf.ts`**'s `timedFetch` replaces `fetch` for every `/api/` call in the views and reads `Server-Timing` back off the response. `logFirstData(view)` logs navigation-start → first-content — the only number including the JS download and hydration that must finish before the first fetch is even issued.

Collection is always on. `PERF_VERBOSE=1` adds the per-span, per-command and re-read breakdown:

```bash
PERF_VERBOSE=1 npm run dev
# [perf] GET /api/goals 179ms | redis=20cmd/170ms | keys=42uniq/0repeat | spans: … 
```

`redis=Ncmd/Mms` is count and the wall-clock time with at least one command in flight — compare `M` to the request total. `keys=Xuniq/Yrepeat` is the waste measure: `Y` is reads for a key this request already fetched.

### The four things that keep it fast

1. **A request-scoped read cache** (`lib/request-cache.ts`), opened by `withPerf` for the length of one request. `settings:vacation` is wanted once per goal by each of three functions; no single call site is wrong, so it's fixed at the request level. **It stores the promise, not the value** — the duplicate callers run inside one `Promise.all` and all ask before any answer arrives, so a value cache would miss every time. Every write in `lib/kv.ts` calls `invalidate()`. Outside a request it's a transparent passthrough.
2. **Priming before fan-out.** `primeDayKeys` and `primeHistoryLengths` fetch every goal's per-day keys (one `mget`: the current week plus each daily goal's reflection lookback) and every goal's history length and first check-in (one pipeline) *before* the per-goal calls, which then hit the cache. `primeTargetHistories` does the same for target history. An `mget`'s cost is the round trip and almost nothing else, so what matters is that each stays *one* command however wide it gets. These are the only places that know a fan-out is happening.
3. **Block-wise streak walks.** Both streaks read a block at a time (`STREAK_DAY_BLOCKS`, `STREAK_WEEK_BLOCKS`), fetching the next only if the previous ran out with the streak alive — a 100-day streak was otherwise 100 serialized `get`s. The blocks **grow** (14, 28, 56, 112, 155) rather than being one fixed width: `mget` is not free per key, so a flat wide block costs more in payload than it saves in round trips.
4. **Server-rendered tracker and history pages**, so the document → chunks → hydrate chain doesn't have to finish before the first fetch is issued. See [Stack](#stack).

`getAllMoodEntries` and `getAllWeeklyNotes` are a `keys` scan plus one pipeline/`mget`, not a `get` per key.

### ⚠️ The function must sit next to Redis

**`vercel.json` pins `regions: ["sfo1"]`, and that is worth more than every code change above combined.** The Redis database resolves to AWS **us-west-1**; Vercel's default is **`iad1` (Virginia)**, so every round trip crossed the continent — roughly 65ms against 9ms, multiplying against the round-trip *count*. `x-vercel-id: sfo1::iad1::…` on a production response is the tell: request enters at the SF edge, function executes in Virginia.

Single-region pinning works on the hobby plan (multi-region needs Pro). If `vercel.json` ever drops it, the equivalent is Project Settings → Functions → Region. **Never let this drift back to a default**, and if the Redis database is moved or recreated, re-check its region and move this with it.

### Why there's no data cache

The tracker renders in ~46ms warm (20 commands, ~4 sequential waves) and ~190ms on a cold start, the difference being the TLS handshake to Upstash plus JIT rather than extra queries. So cold start, not query volume, is what's left — and a cross-request cache could save at most those 46ms while paying in staleness about whether a habit is checked in, the single fact the app exists to record. The cache that mattered is the request-scoped one, which can't outlive the request.

If cold starts ever need attacking, the lever is the Edge runtime (near-zero boot; `@upstash/redis` is fetch-based) — but that constrains what routes can import (`app/api/coach` uses the Anthropic SDK), so measure first.

## Tests

Vitest, in `test/`. CI runs lint → typecheck → test → build on every push to `main` and every PR.

**No live Redis.** `test/setup.ts` mocks `@upstash/redis` so every `new Redis(...)` returns the shared in-memory `FakeRedis` from `test/redis-fake.ts`. It implements exactly the surface `lib/kv.ts` uses and preserves the semantics `kv.ts` depends on: `mget` returns `null` for missing keys, lists are newest-first via `lpush`, and **`set` with `nx` returns `null` rather than `"OK"` when the key exists** — the ladder's no-double-send guarantee *is* that return value, so a fake that always said `"OK"` would make a broken dispatch look correct. Add a command to `kv.ts` and the fake needs it too.

The fake **records every command** in `fakeRedis.calls` (as `"<command> <keys>"`), with `countCommands(fn)` as the wrapper. Round-trip count is what decides how a page feels against a REST Redis and is a property no assertion on returned data can catch — an N+1 returns the right answer, just slowly. `pipeline().exec()` records as the single round trip it is, keeping the keys it batched.

**Time is pinned** to Wed 26 Aug 2026 in the data-layer suites. The day matters: a Wednesday leaves 5 days in the week, which is the only way to construct both the "still winnable" and "already out of reach" weekly cases. Never write a test that depends on the day it happens to run.

| Suite | Covers |
|---|---|
| `week-keys` | ISO week numbering, incl. a 400-day sweep across both year boundaries |
| `reflection` | every branch of `getReflectionPrompt` — the lookback window, the days it must never ask about, which day a weekly prompt names, and what `saveReflection` files where vs what the grid shows |
| `graduation` | eligibility, freeze/restore, the untracked guarantees, the history window ending at `graduatedAt` |
| `nudges` | the `getPendingNudges` predicate and the pure schedule: `nudgeSlots`, `dueSlotIndices`, `habitCallStart`, `nextCallTime`, `callScript`, and the overnight maths |
| `snooze` | the reply grammar, both confirmations, and `snoozeHold`'s clamp |
| `phone` | E.164 canonicalization, incl. the legacy-format inbound match |
| `nudge-ladder` | the dispatch route end to end (below) |
| `nudge-inbound` | the Sendblue reply webhook — secret gate, both commands, scope, clamp messaging |
| `notes` | four-section round-trip, pre-sections prose surviving an edit, the last-week ceiling, newest-three pagination |
| `target-history` | what `recordTargetChange` logs and declines to log, `buildTargetTrend`, and `targetAsOf` scoring a week against the target it had |
| `vacation` | the plans the API refuses, the `goalIds` derived from zeros, and what a planned week does to scoring and nudging |
| `meeting-notes` | the Fathom scrape and the two notes it writes (summarizer mocked) |
| `batching` | round-trip counts of the page-load reads (below) |
| `tabs` | nav visibility, and an empty hidden set storing as absent |
| `push` | subscription allowlist, the manifest start path, and a reminder delivered beside the text (including a person with no phone) |
| `checkin-push` | a live check-in reaches the partner's devices under its own tag; ntfy only when that push doesn't land |
| `pull` | how far a finger has to travel before a pull reloads, and a sideways drag not counting |

**`nudge-ladder`** is the one suite that drives an API route rather than the data layer. It replays a PST day at the real cron cadence (a POST every 10 simulated minutes) with Sendblue and Twilio mocked, asserting the exact transcript of what went out and when. The clock is the input under test, so ticks set the system time and let the route read it. Ticks past midnight are logged as `24:10` rather than `00:10`, so a transcript sorts in ladder order — the same reason `lib/nudges.ts` counts in minutes. The Twilio mock is a knob for what the *called party* did (`reached`/`missed`/`pending`), since that outcome is the only thing driving the retry loop.
It pins per-habit independence (two clocks, two ladders; same-tick habits merging into one call; a habit past `DAY_END` still getting three texts), every escape hatch (a mute removing everything remaining including the partner alert; answering the phone doing the same; a snooze skipping reminders during the hold and resuming after; ten replays of one tick sending exactly once), and the overnight cases (a 23:30 ladder finishing at 01:10; a 23:55 check-in stopping the 00:20 call; a mute written after midnight under yesterday's key being honoured; an ordinary 18:00 habit **not** reopening after midnight). Pauses and snooze clamps are driven through the real inbound webhook rather than by seeding keys, since the webhook is the half that writes them.

**`batching`** guards the latency work: that `getGoalStatuses` doesn't scale round trips with habit count, that `settings:vacation` is read exactly once, that the history-length and target-history fan-outs each go out as one pipeline, that a 40-day streak costs under ten commands, and that the grid's check-in keys aren't re-read by the streak walk. Bounds are a little loose — they catch a reintroduced fan-out, not a benign refactor. Two correctness tests sit alongside, because a read cache's failure mode is staleness: a check-in written earlier in the same request must be visible later, and nothing may leak between requests. **Every test opens a scope with `runWithCache`**, because that's what a real request does; without one the cache is a passthrough and the counts measure the wrong thing.

`scripts/seed-reflection-demo.mts` is **not** a test — it seeds a disposable `reflectdemo` user against live Redis for manual browser QA of the modals, trophy shelf and graduated cards. Its `gradold` habit graduated 120 days ago deliberately: a graduated card only misbehaves once graduation falls outside the 91-day grid. `npx tsx --env-file=.env.local scripts/seed-reflection-demo.mts [clean]`.
