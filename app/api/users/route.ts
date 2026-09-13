import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import {
  getUsers,
  addUser,
  removeUser,
  setUserPhone,
  setUserPartnerPhone,
  setUserHiddenTabs,
} from "@/lib/kv";

async function GETHandler() {
  return NextResponse.json(await getUsers());
}

async function POSTHandler(req: Request) {
  const { id, label, checkinTopic, phone } = await req.json();
  if (!id || !label) {
    return NextResponse.json({ error: "id and label required" }, { status: 400 });
  }
  await addUser(id, label, checkinTopic, phone);
  return NextResponse.json({ ok: true });
}

async function PATCHHandler(req: Request) {
  const { id, phone, partnerPhone, hiddenTabs } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  // Each field is only touched when its key is present, so editing one can't blank the others.
  if (phone !== undefined) await setUserPhone(id, phone);
  if (partnerPhone !== undefined) await setUserPartnerPhone(id, partnerPhone);
  if (Array.isArray(hiddenTabs)) await setUserHiddenTabs(id, hiddenTabs);
  return NextResponse.json({ ok: true });
}

async function DELETEHandler(req: Request) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await removeUser(id);
  return NextResponse.json({ ok: true });
}

export const GET = withPerf("GET /api/users", GETHandler);
export const POST = withPerf("POST /api/users", POSTHandler);
export const PATCH = withPerf("PATCH /api/users", PATCHHandler);
export const DELETE = withPerf("DELETE /api/users", DELETEHandler);
