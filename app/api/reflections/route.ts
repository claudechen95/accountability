import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import { saveReflection, resolveUser } from "@/lib/kv";

async function POSTHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { goalId, text, dates } = await req.json();
    if (!goalId || typeof text !== "string") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    // The days the open sheet named. Omitted means the server still derives them.
    // An empty list is a weekly sheet with no day, which also derives. Garbage is dropped.
    const aboutDates = Array.isArray(dates)
      ? dates
          .filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
          .slice(0, 14)
      : undefined;
    await saveReflection(goalId, text.trim(), user, aboutDates);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to save reflection" }, { status: 500 });
  }
}

export const POST = withPerf("POST /api/reflections", POSTHandler);
