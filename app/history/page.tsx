import { HistoryPage } from "@/app/components/HistoryView";
import { getGoalHistories } from "@/lib/kv";
import { measure } from "@/lib/perf";

// Today's grid, per request - nothing to cache across midnight.
export const dynamic = "force-dynamic";

// Alan's un-prefixed namespace (see resolveUser), server-rendered like /[user]/history.
export default async function Page() {
  const history = await measure("RSC /history", () => getGoalHistories());
  return <HistoryPage initialHistory={history} />;
}
