#!/usr/bin/env node
// Usage: node scripts/ingest-transcripts.mjs <folder>
// One-time/manual ingestion: walks a folder of coaching-session .txt transcripts,
// cleans + chunks them, and upserts them into the Upstash Vector index (which must
// already exist with a hosted embedding model attached — see README/plan for setup).
// Re-running is safe: chunk ids are deterministic, so upserts overwrite in place.

import { Index } from "@upstash/vector";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join, extname, basename } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
const envLines = readFileSync(envPath, "utf8").split("\n");
for (const line of envLines) {
  const match = line.match(/^([^=]+)="?([^"]*)"?$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const folder = process.argv[2];
if (!folder) {
  console.error("Usage: node scripts/ingest-transcripts.mjs <folder>");
  process.exit(1);
}

if (!process.env.UPSTASH_VECTOR_REST_URL || !process.env.UPSTASH_VECTOR_REST_TOKEN) {
  console.error("UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN must be set in .env.local");
  process.exit(1);
}

// Shared Upstash Vector database (also used by the unrelated provenance-mcp project) —
// namespaced so this app's transcript chunks never collide with its data.
const COACH_NAMESPACE = "coach-transcripts";

const index = new Index({
  url: process.env.UPSTASH_VECTOR_REST_URL,
  token: process.env.UPSTASH_VECTOR_REST_TOKEN,
}).namespace(COACH_NAMESPACE);

const CHUNK_SIZE = 3000;
const CHUNK_OVERLAP = 300;
const BATCH_SIZE = 50;

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanTitle(filename) {
  let title = filename.replace(/\.txt$/i, "");
  title = title.replace(/\s*\(\d+-\d+\)\s*-\s*Breakthrough-\s*Personal Power$/i, "");
  title = title.replace(/^\d+\.\s*/, "");
  return title.trim();
}

function cleanBody(raw) {
  return raw
    .split("\n")
    .filter((line) => !/^Transcript:/.test(line) && !/^Language:/.test(line))
    .map((line) => line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*speaker_\d+:\s*/, ""))
    .join(" ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function chunkText(text) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > CHUNK_SIZE && current.length > 0) {
      chunks.push(current.trim());
      // carry the tail of the current chunk forward as overlap
      current = current.slice(Math.max(0, current.length - CHUNK_OVERLAP));
    }
    current += (current ? " " : "") + sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function walkTranscriptFiles(root) {
  const files = [];
  for (const dayFolder of readdirSync(root)) {
    const dayPath = join(root, dayFolder);
    if (!statSync(dayPath).isDirectory()) continue;
    for (const file of readdirSync(dayPath)) {
      if (extname(file).toLowerCase() !== ".txt") continue;
      files.push({ day: dayFolder, file, path: join(dayPath, file) });
    }
  }
  return files;
}

async function main() {
  const files = walkTranscriptFiles(resolve(folder));
  console.log(`Found ${files.length} transcript files under ${folder}`);

  let totalChunks = 0;
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await index.upsert(batch);
    totalChunks += batch.length;
    batch = [];
  };

  for (const { day, file, path } of files) {
    const session = cleanTitle(file);
    const body = cleanBody(readFileSync(path, "utf8"));
    const chunks = chunkText(body);

    chunks.forEach((chunkText, i) => {
      batch.push({
        id: slug(`${day}-${session}-${i}`),
        data: chunkText,
        metadata: { day, session, file: basename(path), chunkIndex: i },
      });
    });

    console.log(`  ${day} / ${session}: ${chunks.length} chunks`);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`\nDone. Upserted ${totalChunks} chunks from ${files.length} files.`);
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
