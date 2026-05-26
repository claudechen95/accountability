import { NextResponse } from "next/server";
import { saveReflection } from "@/lib/kv";

export async function POST(req: Request) {
  try {
    const { goalId, text } = await req.json();
    if (!goalId || typeof text !== "string") {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    await saveReflection(goalId, text.trim());
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to save reflection" }, { status: 500 });
  }
}
