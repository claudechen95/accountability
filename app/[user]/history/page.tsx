import { HistoryPage } from "@/app/components/HistoryView";
import { getGoalHistories, resolveUser } from "@/lib/kv";
import { measure } from "@/lib/perf";

// Today's grid, per request - nothing to cache across users or across midnight.
export const dynamic = "force-dynamic";

// Server-rendered for the same reason as the tracker page: this view's data is the whole page,
// so fetching it after hydration means the user waits for the JS bundle first.
export default async function Page({ params }: { params: { user: string } }) {
  const history = await measure("RSC /[user]/history", () =>
    getGoalHistories(resolveUser(params.user))
  );
  return <HistoryPage userId={params.user} initialHistory={history} />;
}
