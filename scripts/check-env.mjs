// Fails loudly when the local toolchain has drifted from the one CI uses.
//
// This exists because the two silently disagreed: `.github/workflows/ci.yml` asked for
// "node-version: 20", which setup-node resolved to whatever 20.x was newest that week, while
// local dev ran a different node with a different bundled npm. Different npm versions resolve
// optional peer deps differently, so a package-lock.json written by one can be rejected outright
// by another - which is how `npm ci` came to fail in CI on a lock file that installed cleanly on
// the machine that wrote it, for several pushes running, before any lint or test got to run.
//
// .nvmrc is the single source of truth for both sides: CI reads it via `node-version-file`, and
// `nvm use` reads it here. npm isn't pinned separately - it's whatever the pinned node ships.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (process.env.SKIP_ENV_CHECK) process.exit(0);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engines = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines ?? {};
const wantNode = readFileSync(join(root, ".nvmrc"), "utf8").trim();
const wantNpm = engines.npm;
// Vercel only builds a major ("24.x") and refuses a discontinued one outright. An exact
// patch in engines.node is read as that major, so the major here has to match .nvmrc or
// CI can be green on a runtime production will not start.
const enginesMajor = String(engines.node ?? "").match(/^(\d+)\./)?.[1];

const gotNode = process.version.replace(/^v/, "");
// npm sets this when it runs a script ("npm/11.19.0 node/v24.21.0 darwin arm64"), which saves
// spawning npm just to ask its version. Falls back for a bare `node scripts/check-env.mjs`.
const gotNpm =
  process.env.npm_config_user_agent?.match(/npm\/(\S+)/)?.[1] ??
  execFileSync("npm", ["-v"], { encoding: "utf8" }).trim();

const problems = [];
if (gotNode !== wantNode) problems.push(`node ${gotNode}, CI uses ${wantNode}`);
if (wantNpm && gotNpm !== wantNpm) problems.push(`npm ${gotNpm}, CI uses ${wantNpm}`);
if (enginesMajor && gotNode.split(".")[0] !== enginesMajor) {
  problems.push(`node ${gotNode} is outside the ${engines.node} range Vercel builds`);
}

if (problems.length > 0) {
  console.error(`\n✖ Toolchain doesn't match CI: ${problems.join("; ")}`);
  console.error(`\n  nvm install ${wantNode} && nvm use\n`);
  console.error("  npm supplies itself with node - matching node matches both.");
  console.error("  SKIP_ENV_CHECK=1 skips this, at the cost of the guarantee it buys.\n");
  process.exit(1);
}
