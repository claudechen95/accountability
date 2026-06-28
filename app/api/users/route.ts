import { NextResponse } from "next/server";
import { getUsers, addUser } from "@/lib/kv";

export async function GET() {
  return NextResponse.json(await getUsers());
}

export async function POST(req: Request) {
  const { id, label, checkinTopic, nudgeTopic } = await req.json();
  if (!id || !label) {
    return NextResponse.json({ error: "id and label required" }, { status: 400 });
  }
  await addUser(id, label, checkinTopic, nudgeTopic);
  return NextResponse.json({ ok: true });
}
