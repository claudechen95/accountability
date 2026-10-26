import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import { notifyCheckIn } from "@/lib/checkin-notify";
import {
  addCheckIn,
  undoCheckIn,
  resolveUser,
  GraduatedGoalError,
} from "@/lib/kv";

async function POSTHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { goalId, date } = await req.json();
    const result = await addCheckIn(goalId, date, user);
    // Awaited so the send finishes before the serverless isolate freezes. Returning first
    // drops the notification after the check-in has already saved.
    if (!date) await notifyCheckIn(goalId, user);
    return NextResponse.json(result);
  } catch (err) {
    // The caller's view of this habit is stale, not broken - it graduated out of tracking.
    if (err instanceof GraduatedGoalError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to check in" }, { status: 500 });
  }
}

async function DELETEHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { goalId } = await req.json();
    const result = await undoCheckIn(goalId, user);
    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to undo check-in" }, { status: 500 });
  }
}

export const POST = withPerf("POST /api/checkins", POSTHandler);
export const DELETE = withPerf("DELETE /api/checkins", DELETEHandler);
