import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import { addMoodEntry, getMoodEntries, getAllMoodEntries, deleteMoodEntry, getTodayDate, resolveUser } from "@/lib/kv";

async function GETHandler(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date");
    const user = resolveUser(searchParams.get("user"));
    if (date === "all" || date === null) {
      const entries = date === "all" ? await getAllMoodEntries(90, user) : await getMoodEntries(getTodayDate(), user);
      return NextResponse.json(entries);
    }
    const entries = await getMoodEntries(date, user);
    return NextResponse.json(entries);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load mood entries" }, { status: 500 });
  }
}

async function POSTHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { emoji, text } = await req.json();
    if (!emoji || typeof text !== "string") {
      return NextResponse.json({ error: "emoji and text are required" }, { status: 400 });
    }
    await addMoodEntry(emoji, text.trim(), user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to save mood entry" }, { status: 500 });
  }
}

async function DELETEHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { id, date } = await req.json();
    if (!id || !date) {
      return NextResponse.json({ error: "id and date are required" }, { status: 400 });
    }
    await deleteMoodEntry(date, id, user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to delete mood entry" }, { status: 500 });
  }
}

export const GET = withPerf("GET /api/mood", GETHandler);
export const POST = withPerf("POST /api/mood", POSTHandler);
export const DELETE = withPerf("DELETE /api/mood", DELETEHandler);
