import { NextResponse } from "next/server";
import { getUsers, addUser, removeUser } from "@/lib/kv";

export async function GET() {
  return NextResponse.json(await getUsers());
}

export async function POST(req: Request) {
  const { id, label, checkinTopic } = await req.json();
  if (!id || !label) {
    return NextResponse.json({ error: "id and label required" }, { status: 400 });
  }
  await addUser(id, label, checkinTopic);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await removeUser(id);
  return NextResponse.json({ ok: true });
}
