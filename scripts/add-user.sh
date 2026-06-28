#!/bin/bash
set -e

# Usage: ./scripts/add-user.sh <id> <label>
# Example: ./scripts/add-user.sh alice "Alice"

ID="${1}"
LABEL="${2:-$1}"

if [[ -z "$ID" ]]; then
  echo "Usage: $0 <user-id> [display-label]"
  echo "Example: $0 alice Alice"
  exit 1
fi

ID_UPPER=$(echo "$ID" | tr '[:lower:]' '[:upper:]')
CHECKIN_TOPIC="${ID}-checkins-$(openssl rand -hex 3)"
NUDGE_TOPIC="${ID}-nudge-$(openssl rand -hex 3)"

echo "Adding user: $LABEL (/$ID)"
echo "  Checkin topic : $CHECKIN_TOPIC"
echo "  Nudge topic   : $NUDGE_TOPIC"
echo ""

# 1. Add to .env.local
ENV_FILE="$(dirname "$0")/../.env.local"
echo "NTFY_${ID_UPPER}_TOPIC=\"${CHECKIN_TOPIC}\"" >> "$ENV_FILE"
echo "NTFY_${ID_UPPER}_NUDGE_TOPIC=\"${NUDGE_TOPIC}\"" >> "$ENV_FILE"
echo "✓ Added to .env.local"

# 2. Push to Vercel
echo "$CHECKIN_TOPIC" | vercel env add "NTFY_${ID_UPPER}_TOPIC" production --force
echo "$NUDGE_TOPIC"   | vercel env add "NTFY_${ID_UPPER}_NUDGE_TOPIC" production --force
echo "✓ Added to Vercel"

# 3. Add user to app/page.tsx (insert before the closing bracket of USERS array)
PAGE="$(dirname "$0")/../app/page.tsx"
# Insert new entry before the closing ]; of the USERS array
sed -i '' "s/^];$/  { id: \"${ID}\", label: \"${LABEL}\" },\n];/" "$PAGE"
echo "✓ Added to app/page.tsx"

# 4. Commit and deploy
git add "$PAGE" "$ENV_FILE"
git commit -m "feat: add ${LABEL} as new user"
git push
echo "✓ Deployed"

echo ""
echo "Done! /${ID} is live. Subscribe to ntfy topics:"
echo "  Habit completions : https://ntfy.sh/${CHECKIN_TOPIC}"
echo "  Nudge reminders   : https://ntfy.sh/${NUDGE_TOPIC}"
