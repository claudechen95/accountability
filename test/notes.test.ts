import { describe, it, expect, beforeEach } from "vitest";
import { fakeRedis } from "./redis-fake";
import { GET, POST } from "@/app/api/notes/route";
import type { WeeklyNote } from "@/lib/types";

// The notes route stores the meeting's four sections as fields rather than one prose blob. What
// matters here is that a section round-trips as a clean bullet list, and that notes written
// before the sections existed still read back with their prose intact.

const WEEK = "2026-W35";

async function save(body: Record<string, unknown>, user?: string) {
  const q = user ? `?user=${user}` : "";
  const res = await POST(
    new Request(`http://localhost/api/notes${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  expect(res.status).toBe(200);
}

async function load(user?: string): Promise<WeeklyNote[]> {
  const q = user ? `?user=${user}` : "";
  const res = await GET(new Request(`http://localhost/api/notes${q}`));
  return res.json();
}

describe("weekly notes", () => {
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
    expect(note.weekLabel).toBe("Week of Aug 24");
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
      weekLabel: "Week of Aug 24",
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

  it("keeps each user's notes in their own namespace", async () => {
    await save({ week: WEEK, headline: "Alan", wentWell: [], didntGoWell: [], actionItems: [] });
    await save({ week: WEEK, headline: "Rochisha", wentWell: [], didntGoWell: [], actionItems: [] }, "rochisha");

    expect((await load())[0].headline).toBe("Alan");
    expect((await load("rochisha"))[0].headline).toBe("Rochisha");
  });
});
