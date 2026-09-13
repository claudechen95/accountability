/**
 * The bottom-nav tabs, in nav order, shared by the nav itself and the admin screen that switches
 * them on and off - so a tab can't exist in one and not the other.
 *
 * `key` is what's persisted in `UserRecord.hiddenTabs`, and it is deliberately *not* the href:
 * the href is a route that could be renamed, while the key is stored in Redis against every user
 * who hid the tab. `label` is the nav label, which is why Reflect and /reflections differ.
 *
 * Home has no key and can't be hidden - it's the tracker, which is the app.
 */
export interface TabDef {
  key: string;
  href: string;
  label: string;
}

export const HIDEABLE_TABS: TabDef[] = [
  { key: "mood", href: "/mood", label: "Mood" },
  { key: "notes", href: "/notes", label: "Notes" },
  { key: "history", href: "/history", label: "History" },
  { key: "reflections", href: "/reflections", label: "Reflect" },
  { key: "coach", href: "/coach", label: "Coach" },
];

/**
 * Hiding a tab only takes it out of the nav - the route itself still renders for anyone who
 * types the URL or follows a bookmark. There's no auth in this app, so a hidden tab is a
 * decluttered nav, never a permission.
 */
export function visibleTabs(hidden: string[] | undefined): TabDef[] {
  if (!hidden || hidden.length === 0) return HIDEABLE_TABS;
  return HIDEABLE_TABS.filter((tab) => !hidden.includes(tab.key));
}
