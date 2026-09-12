import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import { getRemindHour, setRemindHour, resolveUser } from "@/lib/kv";

async function GETHandler(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const remindHour = await getRemindHour(user);
  return NextResponse.json({ remindHour });
}

async function POSTHandler(req: Request) {
  const user = resolveUser(new URL(req.url).searchParams.get("user"));
  const { remindHour } = await req.json();
  if (typeof remindHour !== "number" || remindHour < 0 || remindHour > 23) {
    return NextResponse.json({ error: "Invalid hour" }, { status: 400 });
  }
  await setRemindHour(remindHour, user);
  return NextResponse.json({ ok: true, remindHour });
}

export const GET = withPerf("GET /api/settings", GETHandler);
export const POST = withPerf("POST /api/settings", POSTHandler);
