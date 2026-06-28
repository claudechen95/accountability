# Accountability Tracker

A personal daily/weekly habit check-in app. Multi-user — each person gets their own isolated dashboard at `/{username}`.

## Local Development

### 1. Get a free Redis database (Upstash)

1. Go to [console.upstash.com](https://console.upstash.com/redis)
2. Create a free Redis database (any region)
3. Click **Connect** → **.env.local** tab
4. Copy the two env vars

### 2. Set up env vars

```bash
cp .env.local.example .env.local
# Edit .env.local and fill in:
#   UPSTASH_REDIS_REST_URL
#   UPSTASH_REDIS_REST_TOKEN
#   NTFY_ALAN_TOPIC          (push notifications for Alan)
#   NTFY_ROCHISHA_NUDGE_TOPIC  (push notifications for Rochisha)
```

### 3. Run locally

```bash
npm install
npm run dev
# → http://localhost:3000
```

## Deploy to Vercel

```bash
npm i -g vercel
vercel
```

Then in the Vercel dashboard, add all env vars under **Settings → Environment Variables**.

## Multi-user

Each user gets a fully isolated namespace in Redis. Data never crosses between users.

| User | URL | Redis prefix |
|------|-----|--------------|
| Alan | `/alan` | *(none — legacy unprefixed keys)* |
| Rochisha | `/rochisha` | `rochisha:` |

### Adding a new user

```bash
./scripts/add-user.sh <id> "<Label>"
# Example:
./scripts/add-user.sh alice "Alice"
```

This handles everything: generates ntfy topic names, adds them to `.env.local` and Vercel, updates `app/page.tsx`, commits, and deploys. It prints the ntfy subscribe URLs at the end for the new user to add on their phone.

No Redis setup needed — same database, automatically isolated under `{userid}:` key prefix.

## Managing Goals

Goals are managed from the UI (drag to reorder, check off habits). To add or change goals via API:

```bash
# Add a goal
POST /api/goals?user=rochisha
{ "id": "my-goal", "name": "My Goal", "emoji": "🎯", "frequency": "daily", "targetCount": 1 }

# Delete a goal
DELETE /api/goals?user=rochisha
{ "id": "my-goal" }
```

## Push Notifications

Nudges are sent via [ntfy.sh](https://ntfy.sh). Each user needs their own topic env var:

- Alan: `NTFY_ALAN_TOPIC`
- Rochisha: `NTFY_ROCHISHA_NUDGE_TOPIC`
- Pattern for new users: `NTFY_{USER_UPPER}_NUDGE_TOPIC`

Trigger a nudge check manually: `GET /api/remind?user=rochisha`
