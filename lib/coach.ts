import Anthropic from "@anthropic-ai/sdk";
import type { CoachMessage } from "./kv";
import type { TranscriptExcerpt } from "./vector";

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  return anthropic;
}

const MODEL = "claude-sonnet-5";
const MAX_HISTORY_MESSAGES = 20;

// One-off, per-turn only — never persisted or indexed, unlike the ingested coaching transcripts.
export interface ChatAttachment {
  kind: "image" | "pdf";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "application/pdf";
  data: string; // base64, no data-url prefix
}

const SYSTEM_PREAMBLE = `You are a personal-development coach, speaking in the voice and style captured in
the excerpts below — direct, energetic, and focused on turning insight into action. These excerpts are drawn
from a 30-day personal-development audio program the user personally owns and is studying; you are a private
study companion for their own reflection, not a public-facing product. Answer as this coach would: draw on the
excerpts for substance and tone, but respond conversationally to what the user actually said rather than reciting
them verbatim. If the excerpts don't cover something, say so plainly and answer from general coaching principles
instead of inventing specifics attributed to the program.`;

const CITATION_INSTRUCTION = `\n\nWhen a specific point in your answer is drawn from one of the excerpts below,
add an inline reference right after that point in the form (Day — Session), e.g. "(Day 1 — Welcome to Personal
Power II!)". Only cite excerpts you actually drew on for that point — don't cite when you're speaking from
general coaching principles instead of the program.`;

function buildSystemPrompt(excerpts: TranscriptExcerpt[]): string {
  if (excerpts.length === 0) return SYSTEM_PREAMBLE;

  const context = excerpts
    .map((e) => `[${e.day} — ${e.session}]\n${e.text}`)
    .join("\n\n---\n\n");

  return `${SYSTEM_PREAMBLE}${CITATION_INSTRUCTION}\n\nRelevant excerpts for this question:\n\n${context}`;
}

// Streams the coach's reply as an async iterable of text deltas. Caller is responsible for
// accumulating the full text (e.g. to persist via addCoachMessage once the stream ends).
// `attachments` (images/PDFs the user attached to their latest message) are attached to that
// turn's Claude call only — they're never persisted or added to the vector index.
export async function* streamCoachReply(
  history: CoachMessage[],
  excerpts: TranscriptExcerpt[],
  attachments: ChatAttachment[] = []
): AsyncGenerator<string> {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);

  const messages = trimmed.map((m, i) => {
    const isLast = i === trimmed.length - 1;
    if (!isLast || attachments.length === 0) {
      return { role: m.role, content: m.text };
    }
    return {
      role: m.role,
      content: [
        { type: "text" as const, text: m.text },
        ...attachments.map((a) =>
          a.kind === "image"
            ? { type: "image" as const, source: { type: "base64" as const, media_type: a.mediaType as Anthropic.Base64ImageSource["media_type"], data: a.data } }
            : { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: a.data } }
        ),
      ],
    };
  });

  const stream = getAnthropic().messages.stream({
    model: MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(excerpts),
    messages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}
