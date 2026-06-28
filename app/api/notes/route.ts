import { NextResponse } from "next/server";
import {
  getWeeklyNote,
  getAllWeeklyNotes,
  saveWeeklyNote,
  deleteWeeklyNote,
  getCurrentWeekKey,
  getWeekLabel,
  seedInitialWeeklyNote,
  seedWeeklyNoteW22,
  seedWeeklyNoteW23,
  seedWeeklyNoteW24,
  seedWeeklyNoteW25,
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
      return NextResponse.json(note || { week, weekLabel: getWeekLabel(week), headline: "", notes: "", changes: [] });
    }

    // Seed Alan's changelog notes for the default (no-user) namespace
    if (!user) {
      await seedInitialWeeklyNote();
      await seedWeeklyNoteW22();
      await seedWeeklyNoteW23();
      await seedWeeklyNoteW24();
      await seedWeeklyNoteW25();
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
    const { week, headline, notes, changes } = body;

    if (!week) {
      return NextResponse.json({ error: "Week is required" }, { status: 400 });
    }

    await saveWeeklyNote({
      week,
      weekLabel: getWeekLabel(week),
      headline: headline || "",
      notes: notes || "",
      changes: changes || [],
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
