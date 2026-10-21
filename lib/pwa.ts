// Where an installed copy of the tracker should open.
//
// The manifest is fetched on its own, so it can't see which page the person is looking at unless
// that page tells it. iOS then ignores the page they were on and opens `start_url`. Unprefixed
// tabs are Alan's, the same split the nav makes; anything that isn't a person's tracker (the
// landing page, admin) opens the landing page rather than guessing a person.

const ALAN_TABS = new Set(["mood", "notes", "history", "reflections", "coach"]);
const SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

export function pwaStartPath(pathname: string): string {
  const first = pathname.split("/").filter(Boolean)[0] ?? "";
  if (!first) return "/";
  if (ALAN_TABS.has(first)) return "/alan";
  if (first === "admin" || first === "api" || !SEGMENT.test(first)) return "/";
  return `/${first}`;
}
