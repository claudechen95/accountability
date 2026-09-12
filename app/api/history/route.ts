import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import { getGoalHistories, resolveUser } from "@/lib/kv";

async function GETHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    return NextResponse.json(await getGoalHistories(user));
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load history" }, { status: 500 });
  }
}

export const GET = withPerf("GET /api/history", GETHandler);
