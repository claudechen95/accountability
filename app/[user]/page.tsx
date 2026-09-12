import { HomePage } from "@/app/components/HabitTracker";
import { getGoalStatuses, getActiveVacation, getUpcomingVacation, resolveUser } from "@/lib/kv";
import { measure } from "@/lib/perf";

// Rendered per request - the habit list is today's state, and there's nothing to cache across
// users or across midnight.
export const dynamic = "force-dynamic";

/**
 * Fetches the tracker's data on the server so it arrives in the HTML.
 *
 * This used to be a one-line pass-through to a client component that fetched on mount, which put
 * the whole document → chunks → hydrate chain (350ms measured locally, more on mobile) in front
 * of the first byte of habit data. The queries are the same ones `/api/goals` and `/api/vacation`
 * run; those routes stay, for the client-side refreshes after a check-in.
 */
export default async function Page({ params }: { params: { user: string } }) {
  const user = resolveUser(params.user);
  const [goals, active, upcoming] = await measure("RSC /[user]", () =>
    Promise.all([getGoalStatuses(user), getActiveVacation(user), getUpcomingVacation(user)])
  );

  return (
    <HomePage userId={params.user} initialGoals={goals} initialVacation={{ active, upcoming }} />
  );
}
