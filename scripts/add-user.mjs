#!/usr/bin/env node
// Usage: node scripts/add-user.mjs <id> [label]
// Adds a user to Redis with generated ntfy topics. No deployment needed.

import { Redis } from "@upstash/redis";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env.local");
const envLines = readFileSync(envPath, "utf8").split("\n");
for (const line of envLines) {
  const match = line.match(/^([^=]+)="?([^"]*)"?$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const id = process.argv[2]?.toLowerCase().trim();
const label = process.argv[3] ?? id;

if (!id) {
  console.error("Usage: node scripts/add-user.mjs <id> [label]");
  process.exit(1);
}

const hex = () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0").slice(0, 6);
const checkinTopic = `${id}-checkins-${hex()}`;

const stored = await kv.get("users") ?? [];
if (stored.find((u) => u.id === id)) {
  console.log(`User "${id}" already exists.`);
  process.exit(0);
}

stored.push({ id, label, checkinTopic });
await kv.set("users", stored);

console.log(`\nAdded: ${label} (/${id})\n`);
console.log("ntfy subscribe link:");
console.log(`  Habit completions : https://ntfy.sh/${checkinTopic}`);
console.log("\nDone — no deployment needed. User appears on the landing page immediately.");
