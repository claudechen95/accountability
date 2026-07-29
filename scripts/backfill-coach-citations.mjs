#!/usr/bin/env node
// Usage: node scripts/backfill-coach-citations.mjs [user]
// One-time backfill: adds inline (Day — Session) citations to existing coach-chat assistant
// replies that predate the citation instruction in lib/coach.ts. Re-retrieves the excerpts that
// would have been available for each reply's original question, then asks Claude to insert
// citations without changing any other wording. Idempotent — skips replies that already cite,
// and skips (rather than mangles) anything the model can't annotate without rewording.

import { Redis } from "@upstash/redis";
import { Index } from "@upstash/vector";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
readFileSync(envPath, "utf8")
  .split("\n")
  .forEach((line) => {
    const m = line.match(/^([^=]+)="?([^"]*)"?$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });

const userArg = process.argv[2];
const key = userArg && userArg !== "alan" ? `${userArg}:coach:chat` : "coach:chat";

const kv = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const vector = new Index({
  url: process.env.UPSTASH_VECTOR_REST_URL,
  token: process.env.UPSTASH_VECTOR_REST_TOKEN,
}).namespace("coach-transcripts");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ANNOTATE_SYSTEM = `You insert inline citations into an already-written coaching reply. You are given the
reply's exact text and the source excerpts that were available when it was written. Wherever a specific point
in the reply is substantively drawn from one of the excerpts, insert an inline citation immediately after it in
the form (Day — Session), e.g. "(Day 1 — Welcome to Personal Power II!)". Do not reword, add, or remove ANY
other text — return the reply completely unchanged except for inserted citation markers. If nothing in the
reply draws on the excerpts, return it completely unchanged. Output only the annotated reply text, nothing else
— no preamble, no explanation.`;

// User messages store attachment content appended after "\n\n--- filename ---" or "\n\n[Attached ...]"
// markers (see app/api/coach/route.ts's processAttachments) — strip that back off to recover the
// original typed question, which is what was actually used to retrieve excerpts at send-time.
function originalQueryFrom(userText) {
  const cut = userText.search(/\n\n(--- |\[Attached)/);
  return (cut === -1 ? userText : userText.slice(0, cut)).trim();
}

async function annotate(replyText, excerpts) {
  const context = excerpts.map((e) => `[${e.metadata?.day} — ${e.metadata?.session}]\n${e.data}`).join("\n\n---\n\n");
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: ANNOTATE_SYSTEM,
    messages: [{ role: "user", content: `Excerpts:\n\n${context}\n\n---\n\nReply to annotate:\n\n${replyText}` }],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block ? block.text : replyText;
}

async function main() {
  const raw = await kv.lrange(key, 0, -1);
  const messages = raw.map((e) => (typeof e === "string" ? JSON.parse(e) : e));
  console.log(`Loaded ${messages.length} messages for key "${key}"`);

  let updated = 0;
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (/\(Day \d/.test(msg.text)) {
      console.log(`  [${i}] already cited, skipping`);
      continue;
    }

    const userMsg = messages[i - 1];
    if (!userMsg || userMsg.role !== "user") continue;

    const query = originalQueryFrom(userMsg.text);
    const results = await vector.query({ data: query, topK: 6, includeMetadata: true, includeData: true });
    if (results.length === 0) {
      console.log(`  [${i}] no excerpts found, skipping`);
      continue;
    }

    const annotated = await annotate(msg.text, results);
    if (annotated.trim() === msg.text.trim()) {
      console.log(`  [${i}] no citations needed`);
      continue;
    }

    await kv.lset(key, i, JSON.stringify({ ...msg, text: annotated }));
    updated++;
    console.log(`  [${i}] annotated`);
  }

  console.log(`\nDone. Annotated ${updated} message(s).`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
