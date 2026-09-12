import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import { addJournalEntry, getJournalEntries, deleteJournalEntry, resolveUser } from "@/lib/kv";

async function GETHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const entries = await getJournalEntries(100, user);
    return NextResponse.json(entries);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to fetch journal" }, { status: 500 });
  }
}

async function POSTHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { text } = await req.json();
    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ error: "Text is required" }, { status: 400 });
    }
    await addJournalEntry(text.trim(), user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to save entry" }, { status: 500 });
  }
}

async function DELETEHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { id } = await req.json();
    await deleteJournalEntry(id, user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to delete entry" }, { status: 500 });
  }
}

export const GET = withPerf("GET /api/journal", GETHandler);
export const POST = withPerf("POST /api/journal", POSTHandler);
export const DELETE = withPerf("DELETE /api/journal", DELETEHandler);
