import { NextResponse } from "next/server";
import { addCoachMessage, getCoachMessages, resolveUser } from "@/lib/kv";
import { streamCoachReply, type ChatAttachment } from "@/lib/coach";
import { searchTranscripts } from "@/lib/vector";

export const maxDuration = 120;

const MAX_ATTACHMENTS = 5;
const MAX_TEXT_CHARS = 50_000;
const MAX_BASE64_CHARS = 14_000_000; // ~10MB raw file

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface RawAttachment {
  kind: "text" | "image" | "pdf";
  filename: string;
  content?: string; // text attachments
  mediaType?: string; // image attachments
  data?: string; // base64, image/pdf attachments
}

// Attachments are one-off context for this single turn only — never persisted as files or
// added to the vector index (unlike the ingested coaching transcripts).
function processAttachments(raw: RawAttachment[]): { appendedText: string; chatAttachments: ChatAttachment[] } {
  let appendedText = "";
  const chatAttachments: ChatAttachment[] = [];

  for (const a of raw.slice(0, MAX_ATTACHMENTS)) {
    if (a.kind === "text" && typeof a.content === "string") {
      appendedText += `\n\n--- ${a.filename} ---\n${a.content.slice(0, MAX_TEXT_CHARS)}`;
    } else if (a.kind === "image" && typeof a.data === "string" && a.mediaType && IMAGE_MEDIA_TYPES.has(a.mediaType)) {
      if (a.data.length > MAX_BASE64_CHARS) continue;
      chatAttachments.push({ kind: "image", mediaType: a.mediaType as ChatAttachment["mediaType"], data: a.data });
      appendedText += `\n\n[Attached image: ${a.filename}]`;
    } else if (a.kind === "pdf" && typeof a.data === "string") {
      if (a.data.length > MAX_BASE64_CHARS) continue;
      chatAttachments.push({ kind: "pdf", mediaType: "application/pdf", data: a.data });
      appendedText += `\n\n[Attached PDF: ${a.filename}]`;
    }
  }

  return { appendedText, chatAttachments };
}

export async function GET(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const messages = await getCoachMessages(user);
    return NextResponse.json(messages);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to load coach chat" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = resolveUser(new URL(req.url).searchParams.get("user"));
    const { message, attachments } = await req.json();
    if (!message || typeof message !== "string" || !message.trim()) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const { appendedText, chatAttachments } = processAttachments(Array.isArray(attachments) ? attachments : []);

    await addCoachMessage("user", message.trim() + appendedText, user);
    const history = await getCoachMessages(user);

    // Ground retrieval in the topic actually under discussion, not just this turn's literal
    // text — otherwise a short follow-up like "add references" or "tell me more" searches on
    // itself and comes back empty even though the prior reply's topic has good matches.
    const priorTurn = history.length >= 2 ? history[history.length - 2] : null;
    const searchQuery = priorTurn ? `${priorTurn.text}\n\n${message.trim()}` : message.trim();
    const excerpts = await searchTranscripts(searchQuery);

    const encoder = new TextEncoder();
    let fullText = "";

    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const delta of streamCoachReply(history, excerpts, chatAttachments)) {
            fullText += delta;
            controller.enqueue(encoder.encode(delta));
          }
          if (fullText) await addCoachMessage("assistant", fullText, user);
          controller.close();
        } catch (err) {
          console.error(err);
          controller.error(err);
        }
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
