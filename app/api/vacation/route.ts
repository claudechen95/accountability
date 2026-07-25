import { NextResponse } from "next/server";
import {
  getActiveVacation,
  getUpcomingVacation,
  startVacation,
  endVacationNow,
  resolveUser,
  getGoals,
  getTodayDate,
} from "@/lib/kv";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const [active, upcoming] = await Promise.all([getActiveVacation(user), getUpcomingVacation(user)]);
  return NextResponse.json({ active, upcoming });
}

export async function POST(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const { startDate, endDate, goalIds } = await req.json();
  const today = getTodayDate();
  if (typeof startDate !== "string" || !DATE_RE.test(startDate) || startDate < today) {
    return NextResponse.json({ error: "Invalid start date" }, { status: 400 });
  }
  if (typeof endDate !== "string" || !DATE_RE.test(endDate) || endDate < startDate) {
    return NextResponse.json({ error: "Invalid end date" }, { status: 400 });
  }
  if (!Array.isArray(goalIds) || goalIds.length === 0) {
    return NextResponse.json({ error: "Select at least one habit" }, { status: 400 });
  }
  const goals = await getGoals(user);
  const validIds = goalIds.filter((id) => goals.some((g) => g.id === id));
  if (validIds.length === 0) {
    return NextResponse.json({ error: "No valid habits selected" }, { status: 400 });
  }
  const window = await startVacation(startDate, endDate, validIds, user);
  const [active, upcoming] = await Promise.all([getActiveVacation(user), getUpcomingVacation(user)]);
  return NextResponse.json({ active, upcoming, window });
}

export async function DELETE(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  await endVacationNow(user);
  return NextResponse.json({ ok: true });
}
