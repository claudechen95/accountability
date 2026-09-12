import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import {
  getGoals,
  saveGoals,
  getGoalStatuses,
  renumberGoals,
  resolveUser,
  recordTargetChange,
  graduateGoal,
  ungraduateGoal,
  snoozeGraduation,
} from "@/lib/kv";

async function GETHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const statuses = await getGoalStatuses(user);
    return NextResponse.json(statuses);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load goals" }, { status: 500 });
  }
}

async function POSTHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const body = await req.json();
    const goals = await getGoals(user);

    // Add or update a goal
    const existing = goals.findIndex((g) => g.id === body.id);
    const previous = existing >= 0 ? { ...goals[existing] } : undefined;
    if (existing >= 0) {
      goals[existing] = { ...goals[existing], ...body };
    } else {
      goals.push(body);
      renumberGoals(goals); // new goal — assign it the next nudge number
    }
    await saveGoals(goals, user);
    // After the save, so a target change is only ever logged for one that actually landed. A
    // no-op for every edit that leaves frequency and targetCount alone.
    await recordTargetChange(goals[existing >= 0 ? existing : goals.length - 1], previous, user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to save goal" }, { status: 500 });
  }
}

async function PATCHHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { orderedIds, goalId, graduation } = await req.json();

    // Graduation actions: graduate | ungraduate | snooze, all keyed on a single goal.
    if (goalId && graduation) {
      if (graduation === "graduate") await graduateGoal(goalId, user);
      else if (graduation === "ungraduate") await ungraduateGoal(goalId, user);
      else if (graduation === "snooze") await snoozeGraduation(goalId, user);
      else return NextResponse.json({ error: "Unknown graduation action" }, { status: 400 });
      return NextResponse.json({ ok: true });
    }

    if (!Array.isArray(orderedIds)) {
      return NextResponse.json({ error: "orderedIds required" }, { status: 400 });
    }
    const goals = await getGoals(user);
    (orderedIds as string[]).forEach((id, index) => {
      const goal = goals.find((g) => g.id === id);
      if (goal) goal.order = index;
    });
    await saveGoals(goals, user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to update order" }, { status: 500 });
  }
}

async function DELETEHandler(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { id } = await req.json();
    const goals = await getGoals(user);
    const remaining = goals.filter((g) => g.id !== id);
    renumberGoals(remaining); // keep nudge numbers compact after a removal
    await saveGoals(remaining, user);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to delete goal" }, { status: 500 });
  }
}

export const GET = withPerf("GET /api/goals", GETHandler);
export const POST = withPerf("POST /api/goals", POSTHandler);
export const PATCH = withPerf("PATCH /api/goals", PATCHHandler);
export const DELETE = withPerf("DELETE /api/goals", DELETEHandler);
