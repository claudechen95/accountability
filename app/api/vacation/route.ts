import { NextResponse } from "next/server";
import { getActiveVacation, startVacation, endVacationNow, resolveUser, getGoals, getTodayDate } from "@/lib/kv";

export async function GET(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const active = await getActiveVacation(user);
  return NextResponse.json({ active });
}

export async function POST(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const { endDate, goalIds } = await req.json();
  if (typeof endDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < getTodayDate()) {
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
  const active = await startVacation(endDate, validIds, user);
  return NextResponse.json({ active });
}

export async function DELETE(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  await endVacationNow(user);
  return NextResponse.json({ ok: true });
}
