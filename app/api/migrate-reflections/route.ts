import { NextResponse } from "next/server";
import { migrateWeekKeyedReflections } from "@/lib/kv";

export async function POST() {
  try {
    const result = await migrateWeekKeyedReflections();
    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Migration failed" }, { status: 500 });
  }
}
