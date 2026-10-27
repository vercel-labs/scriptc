#!/usr/bin/env node
/* Regenerates the committed generated files from their sources, so a merge
 * never resolves one by hand:
 *
 *   packages/compiler/surface-manifest.json          pnpm manifest
 *   internal/compatibility/generated/node-v24-internal.json
 *   docs/src/generated/node-v24-compatibility.json   pnpm node-compat --local
 *
 * During a merge, rebase or cherry-pick, resolve the conflicts in source
 * files first. Each generated file git still reports as conflicted is then
 * written from one side of the conflict, every file is regenerated from the
 * merged sources, and only then are the conflicted ones staged: when a
 * generator fails they stay unmerged. The side is the one whose ledger is
 * for the merged Node pin (node-v24.json), which offline regeneration
 * needs; when neither is, run `pnpm node-compat`, which fetches the pinned
 * Node docs, instead.
 *
 *   node scripts/regen-generated.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const GENERATED = [
  "packages/compiler/surface-manifest.json",
  "internal/compatibility/generated/node-v24-internal.json",
  "docs/src/generated/node-v24-compatibility.json",
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result.stdout.toString();
}

const git = (...args) => run("git", args);
const LEDGER = "internal/compatibility/generated/node-v24-internal.json";

/** A conflicted file's content on one side: index stage 2 (ours) or 3 (theirs), or null if absent there. */
function side(stage, path) {
  const result = spawnSync("git", ["show", `:${stage}:${path}`], { cwd: root, maxBuffer: 1 << 30 });
  return result.status === 0 ? result.stdout : null;
}

/** The side (2 or 3) to take the conflicted files from: the one whose ledger is for the merged pin. */
function chooseSide(conflicted) {
  if (!conflicted.includes(LEDGER)) return 2;
  const pin = JSON.parse(readFileSync(join(root, "internal/compatibility/node-v24.json"), "utf8"));
  const forPin = (stage) => {
    const text = side(stage, LEDGER);
    if (text === null) return false;
    const ledger = JSON.parse(text.toString("utf8"));
    return ledger.nodeVersion === pin.version && ledger.nodeCommit === pin.commit;
  };
  if (forPin(2)) return 2;
  if (forPin(3)) return 3;
  throw new Error(
    `neither side's ledger is for Node ${pin.version} (${pin.commit.slice(0, 12)}); run 'pnpm manifest' and 'pnpm node-compat', which fetches the pinned Node docs, then stage the generated files`,
  );
}

const unmerged = new Set(git("diff", "--name-only", "--diff-filter=U").split("\n"));
const conflicted = GENERATED.filter((path) => unmerged.has(path));
if (conflicted.length > 0) {
  const stage = chooseSide(conflicted);
  // Written to the working tree only: the index keeps the conflict until
  // regeneration succeeds.
  for (const path of conflicted) {
    const text = side(stage, path) ?? side(5 - stage, path);
    if (text !== null) writeFileSync(join(root, path), text);
  }
  console.log(`took ${stage === 2 ? "ours" : "theirs"} for ${conflicted.join(", ")}`);
}
process.stdout.write(run("pnpm", ["--silent", "manifest"]));
process.stdout.write(run(process.execPath, ["internal/compatibility/src/generate.mjs", "--local"]));
if (conflicted.length > 0) {
  git("add", "--", ...conflicted);
  console.log(`staged ${conflicted.join(", ")}`);
}
