import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { fakeRedis } from "./redis-fake";
import { GET, POST } from "@/app/api/notes/route";
import type { WeeklyNote } from "@/lib/types";

// The notes route stores the meeting's four sections as fields rather than one prose blob. What
// matters here is that a section round-trips as a clean bullet list, that notes written before
// the sections existed still read back with their prose intact, and that a note can only be
// started for a week that has finished.

// Wed 26 Aug 2026, noon PDT - the same pinned clock the data-layer suites use. It matters here
// because the week a note is allowed to be written for is relative to today: WEEK is last week.
const NOW = new Date("2026-08-26T19:00:00Z");
const WEEK = "2026-W34";
const THIS_WEEK = "2026-W35";

async function post(body: Record<string, unknown>, user?: string) {
  const q = user ? `?user=${user}` : "";
  return POST(
    new Request(`http://localhost/api/notes${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function save(body: Record<string, unknown>, user?: string) {
  const res = await post(body, user);
  expect(res.status).toBe(200);
}

async function page(limit?: number, user?: string): Promise<{ notes: WeeklyNote[]; total: number }> {
  const params = new URLSearchParams();
  if (user) params.set("user", user);
  if (limit) params.set("limit", String(limit));
  const res = await GET(new Request(`http://localhost/api/notes?${params}`));
  return res.json();
}

async function load(user?: string): Promise<WeeklyNote[]> {
  return (await page(undefined, user)).notes;
}

describe("weekly notes", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterAll(() => vi.useRealTimers());
  beforeEach(() => {
    fakeRedis.reset();
  });

  it("round-trips the four sections", async () => {
    await save({
      week: WEEK,
      headline: "Mixed week",
      wentWell: ["Piano was consistent", "Stretch felt easy"],
      didntGoWell: ["Gym block slid again"],
      actionItems: ["Book the Saturday class"],
    });

    const [note] = await load();
    expect(note.week).toBe(WEEK);
    expect(note.weekLabel).toBe("Week of Aug 17");
    expect(note.headline).toBe("Mixed week");
    expect(note.wentWell).toEqual(["Piano was consistent", "Stretch felt easy"]);
    expect(note.didntGoWell).toEqual(["Gym block slid again"]);
    expect(note.actionItems).toEqual(["Book the Saturday class"]);
  });

  // A textarea ends with a newline as soon as the user hits enter for the next bullet, so the
  // blank has to be dropped on write rather than rendered as an empty list item.
  it("drops blank bullets", async () => {
    await save({
      week: WEEK,
      headline: "H",
      wentWell: ["Piano", "   ", "", "Stretch"],
      didntGoWell: [],
      actionItems: ["  Book the class  "],
    });

    const [note] = await load();
    expect(note.wentWell).toEqual(["Piano", "Stretch"]);
    expect(note.didntGoWell).toEqual([]);
    expect(note.actionItems).toEqual(["Book the class"]);
  });

  it("never writes the retired prose fields for a new note", async () => {
    await save({ week: WEEK, headline: "H", wentWell: [], didntGoWell: [], actionItems: [], notes: "", changes: [] });

    const [note] = await load();
    expect(note.notes).toBeUndefined();
    expect(note.changes).toBeUndefined();
  });

  // Editing a note written before the sections existed must not blank the prose it still shows.
  it("preserves the prose of a pre-sections note through an edit", async () => {
    const legacy = {
      week: WEEK,
      weekLabel: "Week of Aug 17",
      headline: "Old headline",
      notes: "One long paragraph about the week.",
      changes: ["Bumped salad to daily"],
      updatedAt: 1,
    };
    await fakeRedis.set(`note:${WEEK}`, legacy);

    await save({
      week: WEEK,
      headline: "Old headline",
      wentWell: ["Piano"],
      didntGoWell: [],
      actionItems: [],
      notes: legacy.notes,
      changes: legacy.changes,
    });

    const [note] = await load();
    expect(note.wentWell).toEqual(["Piano"]);
    expect(note.notes).toBe(legacy.notes);
    expect(note.changes).toEqual(legacy.changes);
  });

  // The picker offers last week and earlier; this is the half of that rule that holds whatever
  // the client sends. A week in progress hasn't happened yet to be written up.
  it("refuses a new note for the week in progress", async () => {
    const res = await post({ week: THIS_WEEK, headline: "Too soon", wentWell: [], didntGoWell: [], actionItems: [] });

    expect(res.status).toBe(400);
    expect(await load()).toEqual([]);
  });

  it("refuses a new note for a future week", async () => {
    const res = await post({ week: "2026-W40", headline: "Next month", wentWell: [], didntGoWell: [], actionItems: [] });

    expect(res.status).toBe(400);
    expect(await load()).toEqual([]);
  });

  // A note filed under a current week before the rule existed must stay editable - the ceiling
  // is on starting one, not on keeping one.
  it("still saves an existing note for the week in progress", async () => {
    await fakeRedis.set(`note:${THIS_WEEK}`, {
      week: THIS_WEEK,
      weekLabel: "Week of Aug 24",
      headline: "Written before the rule",
      updatedAt: 1,
    });

    await save({ week: THIS_WEEK, headline: "Edited", wentWell: ["Piano"], didntGoWell: [], actionItems: [] });

    const [note] = await load();
    expect(note.headline).toBe("Edited");
    expect(note.wentWell).toEqual(["Piano"]);
  });

  // The page opens on three weeks and asks for more by hand. The limit has to pick the *newest*
  // weeks: `kv.keys` answers in no particular order, so slicing before sorting handed back an
  // arbitrary three of them.
  it("returns the newest weeks for a limit, and the total to ask for more", async () => {
    for (const w of ["2026-W28", "2026-W34", "2026-W30", "2026-W26", "2026-W32"]) {
      await save({ week: w, headline: w, wentWell: [], didntGoWell: [], actionItems: [] });
    }

    const first = await page(3);
    expect(first.total).toBe(5);
    expect(first.notes.map((n) => n.week)).toEqual(["2026-W34", "2026-W32", "2026-W30"]);

    const more = await page(6);
    expect(more.notes.map((n) => n.week)).toEqual([
      "2026-W34", "2026-W32", "2026-W30", "2026-W28", "2026-W26",
    ]);
  });

  it("keeps each user's notes in their own namespace", async () => {
    await save({ week: WEEK, headline: "Alan", wentWell: [], didntGoWell: [], actionItems: [] });
    await save({ week: WEEK, headline: "Rochisha", wentWell: [], didntGoWell: [], actionItems: [] }, "rochisha");

    expect((await load())[0].headline).toBe("Alan");
    expect((await load("rochisha"))[0].headline).toBe("Rochisha");
  });
});
