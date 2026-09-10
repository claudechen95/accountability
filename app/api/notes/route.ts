import { NextResponse } from "next/server";
import {
  getWeeklyNote,
  getAllWeeklyNotes,
  saveWeeklyNote,
  deleteWeeklyNote,
  getCurrentWeekKey,
  getWeekLabel,
  resolveUser,
} from "@/lib/kv";

// Get all notes or a specific week
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const week = searchParams.get("week");
    const user = resolveUser(searchParams.get("user"));

    if (week) {
      const note = await getWeeklyNote(week, user);
      return NextResponse.json(
        note || {
          week,
          weekLabel: getWeekLabel(week),
          headline: "",
          wentWell: [],
          didntGoWell: [],
          actionItems: [],
        }
      );
    }

    const notes = await getAllWeeklyNotes(52, user);
    return NextResponse.json(notes);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load notes" }, { status: 500 });
  }
}

// Create or update a note
export async function POST(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const body = await req.json();
    const { week, headline, wentWell, didntGoWell, actionItems, notes, changes } = body;

    if (!week) {
      return NextResponse.json({ error: "Week is required" }, { status: 400 });
    }

    // Drop blank bullets rather than storing them - a trailing newline in a textarea shouldn't
    // become an empty list item on the card.
    const bullets = (value: unknown): string[] =>
      Array.isArray(value) ? value.map((s) => String(s).trim()).filter(Boolean) : [];

    await saveWeeklyNote({
      week,
      weekLabel: getWeekLabel(week),
      headline: headline || "",
      wentWell: bullets(wentWell),
      didntGoWell: bullets(didntGoWell),
      actionItems: bullets(actionItems),
      // Passed through only when the client is editing a pre-sections note, so editing one
      // doesn't blank the prose it still displays.
      ...(notes ? { notes } : {}),
      ...(changes?.length ? { changes } : {}),
    }, user);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to save note" }, { status: 500 });
  }
}

// Delete a note
export async function DELETE(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { week } = await req.json();

    if (!week) {
      return NextResponse.json({ error: "Week is required" }, { status: 400 });
    }

    await deleteWeeklyNote(week, user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to delete note" }, { status: 500 });
  }
}
