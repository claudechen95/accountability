import { NextResponse } from "next/server";
import { getRemindHour, setRemindHour, resolveUser } from "@/lib/kv";

export async function GET(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const remindHour = await getRemindHour(user);
  return NextResponse.json({ remindHour });
}

export async function POST(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const { remindHour } = await req.json();
  if (typeof remindHour !== "number" || remindHour < 0 || remindHour > 23) {
    return NextResponse.json({ error: "Invalid hour" }, { status: 400 });
  }
  await setRemindHour(remindHour, user);
  return NextResponse.json({ ok: true, remindHour });
}
