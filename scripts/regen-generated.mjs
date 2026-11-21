#!/usr/bin/env node
/* Regenerates the committed generated files from their sources, so a merge
 * never resolves one by hand:
 *
 *   packages/compiler/surface-manifest.json               pnpm manifest
 *   packages/compiler/src/frontend/ts7/*.generated.ts     pnpm generate:ts7-ast
 *   packages/compiler/src/ir/fields.generated.ts          pnpm generate:ir-fields
 *   packages/compiler/src/ir/codec.generated.ts           pnpm generate:ir-codec
 *   packages/compiler/src/frontend/lowering/*.generated.ts
 *                                                         node scripts/gen-builtin-*.mjs
 *   internal/compatibility/generated/node-v24-internal.json
 *   internal/compatibility/generated/node-v24-refusals.json
 *   packages/experimental/refusals.json
 *   docs/src/generated/node-v24-compatibility.json         pnpm node-compat --local
 *   packages/runtime/refusal-sites.json                   node scripts/runtime-refusals.mjs --write
 *
 * Recorded from a run rather than derived from committed sources, so only a
 * merge that left one conflicted regenerates them, for the conflicted entries:
 *
 *   tests/harness/corpus-costs.json                       node scripts/ci-corpus-costs.mjs
 *   scripts/ci-test-costs.json and tests/harness/*-costs.json
 *                                                         node scripts/ci-test-costs.mjs
 *                                                         node scripts/ci-effect-costs.mjs
 *   packages/compiler/test/ts7/baselines/order-parity/**   SCRIPTC_UPDATE_BASELINES=1 vitest
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
 *   pnpm regen
 *   pnpm regen --corpus-costs   also fold the per-program corpus cost files
 *   pnpm regen --ts7-baselines  also re-record every order-parity baseline
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const TS7_BASELINE_DIR = "packages/compiler/test/ts7/baselines/order-parity/";
const CORPUS_COSTS = "tests/harness/corpus-costs.json";
const SHARD_COST_TABLES = [
  "scripts/ci-test-costs.json",
  "tests/harness/effect-costs.json",
  "tests/harness/effect4-costs.json",
  "tests/harness/npm-static-costs.json",
  "tests/harness/self-hosting-llvm-emitter-costs.json",
  "tests/harness/three-library-costs.json",
  "tests/harness/ts7-host-reuse-parity-costs.json",
];
const COMPAT_GENERATED = [
  "packages/compiler/surface-manifest.json",
  "internal/compatibility/generated/node-v24-internal.json",
  "internal/compatibility/generated/node-v24-refusals.json",
  "packages/experimental/refusals.json",
  "docs/src/generated/node-v24-compatibility.json",
];
const NODE_SOURCES = [
  "packages/compiler/src/frontend/lowering/builtin-module-members.generated.ts",
  "packages/compiler/src/frontend/lowering/builtin-object-members.generated.ts",
];
const GENERATED = [
  ...COMPAT_GENERATED,
  ...NODE_SOURCES,
  "packages/compiler/src/frontend/ts7/enums.generated.ts",
  "packages/compiler/src/frontend/ts7/ast-schema.generated.ts",
  "packages/compiler/src/frontend/ts7/ast-guards.generated.ts",
  "packages/compiler/src/frontend/ts7/ast-tokens.generated.ts",
  "packages/compiler/src/frontend/ts7/ast-types.generated.ts",
  "packages/compiler/src/frontend/ts7/semantic-schema.generated.ts",
  "packages/compiler/src/frontend/ts7/session-schema.generated.ts",
  "packages/compiler/src/ir/fields.generated.ts",
  "packages/compiler/src/ir/codec.generated.ts",
  "packages/runtime/refusal-sites.json",
  CORPUS_COSTS,
];

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status}`);
  }
  return result.stdout.toString();
}

const git = (...gitArgs) => run("git", gitArgs);

/** A conflicted file's content on one side: index stage 2 (ours) or 3 (theirs), or null if absent there. */
function side(stage, path) {
  const result = spawnSync("git", ["show", `:${stage}:${path}`], { cwd: root, maxBuffer: 1 << 30 });
  return result.status === 0 ? result.stdout : null;
}

/** The side (2 or 3) to take the conflicted files from: the one whose ledger is for the merged pin. */
function chooseSide(conflicted) {
  const ledger = "internal/compatibility/generated/node-v24-internal.json";
  if (!conflicted.includes(ledger)) return 2;
  const pin = JSON.parse(readFileSync(join(root, "internal/compatibility/node-v24.json"), "utf8"));
  const forPin = (stage) => {
    const text = side(stage, ledger);
    if (text === null) return false;
    const parsed = JSON.parse(text.toString("utf8"));
    return parsed.nodeVersion === pin.version && parsed.nodeCommit === pin.commit;
  };
  if (forPin(2)) return 2;
  if (forPin(3)) return 3;
  throw new Error(
    `neither side's ledger is for Node ${pin.version} (${pin.commit.slice(0, 12)}); run 'pnpm manifest' and 'pnpm node-compat', which fetches the pinned Node docs, then stage the generated files`,
  );
}

const unmerged = new Set(git("diff", "--name-only", "--diff-filter=U").split("\n"));
const conflicted = GENERATED.filter((path) => unmerged.has(path));
const conflictedBaselines = [...unmerged].filter(
  (path) => path.startsWith(TS7_BASELINE_DIR) && path.endsWith(".json"),
);
const corpusCostsConflicted = unmerged.has(CORPUS_COSTS);
const isShardCostTable = (path) =>
  path === "scripts/ci-test-costs.json" ||
  (path !== CORPUS_COSTS && /^tests\/harness\/[^/]+-costs\.json$/.test(path));
const conflictedShardCosts = [...unmerged].filter(isShardCostTable);
const conflictedCorpusCostFiles = [...unmerged].filter(
  (path) => path.startsWith("tests/harness/corpus-costs/") && path.endsWith(".json"),
);
const unknownShardCosts = conflictedShardCosts.filter((path) => !SHARD_COST_TABLES.includes(path));
if (unknownShardCosts.length > 0)
  throw new Error(
    `no generator for conflicted shard cost table(s): ${unknownShardCosts.join(", ")}; add ${unknownShardCosts.length === 1 ? "it" : "them"} to SHARD_COST_TABLES in scripts/regen-generated.mjs instead of resolving by hand`,
  );
const conflictedAll = [...new Set([...conflicted, ...conflictedShardCosts])];

if (conflictedAll.length > 0) {
  const stage = chooseSide(conflictedAll);
  // Written to the working tree only: the index keeps the conflict until
  // regeneration succeeds.
  for (const path of conflictedAll) {
    const text = side(stage, path) ?? side(5 - stage, path);
    if (text !== null) writeFileSync(join(root, path), text);
  }
  console.log(`took ${stage === 2 ? "ours" : "theirs"} for ${conflictedAll.join(", ")}`);
}
if (conflictedBaselines.length > 0) console.log(`re-recording ${conflictedBaselines.join(", ")}`);
else if (args.has("--ts7-baselines")) console.log("re-recording every order-parity baseline");
if (corpusCostsConflicted || conflictedCorpusCostFiles.length > 0 || args.has("--corpus-costs"))
  console.log(`folding the per-program corpus costs into ${CORPUS_COSTS}`);

// These read the member surface of the pinned Node release and refuse to run
// on another version; a checkout on the wrong Node keeps its committed copy.
// They go first because the surface manifest projects the tables they write.
const nodePin = readFileSync(join(root, ".node-version"), "utf8").trim();
const builtinTablesRegenerated = process.version === `v${nodePin}`;
if (builtinTablesRegenerated) {
  process.stdout.write(run(process.execPath, ["scripts/gen-builtin-module-members.mjs"]));
  process.stdout.write(run(process.execPath, ["scripts/gen-builtin-object-members.mjs"]));
} else {
  console.warn(
    `skipped the builtin member tables: they are generated from Node ${nodePin} (this is ${process.version})`,
  );
}

process.stdout.write(run("pnpm", ["--silent", "manifest"]));
process.stdout.write(run("pnpm", ["--silent", "generate:ts7-ast"]));
process.stdout.write(run("pnpm", ["--silent", "generate:ir-fields"]));
process.stdout.write(run("pnpm", ["--silent", "generate:ir-codec"]));
process.stdout.write(run(process.execPath, ["internal/compatibility/src/generate.mjs", "--local"]));
process.stdout.write(run(process.execPath, ["scripts/runtime-refusals.mjs", "--write"]));

if (corpusCostsConflicted || conflictedCorpusCostFiles.length > 0 || args.has("--corpus-costs")) {
  // ci-corpus-costs folds every per-program override, sorts the table, and
  // deletes the folded files: the union of both merge sides, not one side.
  for (const path of [CORPUS_COSTS, ...conflictedCorpusCostFiles]) {
    const text = side(2, path) ?? side(3, path);
    if (text !== null) writeFileSync(join(root, path), text);
  }
  process.stdout.write(run(process.execPath, ["scripts/ci-corpus-costs.mjs"]));
  git("add", "-A", "--", CORPUS_COSTS, "tests/harness/corpus-costs");
}

if (conflictedShardCosts.length > 0) {
  // Without log arguments these refresh the tables from the committed rows:
  // they sort, prune entries for files or fixtures that no longer exist, and
  // leave every measurement they were not given. Both writers run because a
  // conflict in one table of a family means the same tests moved on both
  // sides; the tables the writers own are staged together.
  process.stdout.write(run(process.execPath, ["scripts/ci-test-costs.mjs"]));
  process.stdout.write(run(process.execPath, ["scripts/ci-effect-costs.mjs"]));
  git("add", "--", ...SHARD_COST_TABLES);
  console.log(`regenerated ${conflictedShardCosts.join(", ")}`);
}

if (conflictedBaselines.length > 0 || args.has("--ts7-baselines")) {
  const fixtures = conflictedBaselines.map((path) =>
    path.slice(TS7_BASELINE_DIR.length, -".json".length),
  );
  const env = { ...process.env, SCRIPTC_UPDATE_BASELINES: "1" };
  if (fixtures.length > 0) env["SCRIPTC_UPDATE_BASELINES_ONLY"] = fixtures.join("\n");
  process.stdout.write(
    run(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "packages/compiler/test/ts7/order-parity.test.ts"],
      env,
    ),
  );
  if (conflictedBaselines.length > 0) git("add", "--", ...conflictedBaselines);
}

const staged = conflictedAll.filter(
  (path) => builtinTablesRegenerated || !NODE_SOURCES.includes(path),
);
if (staged.length > 0) {
  git("add", "--", ...staged);
  console.log(`staged ${staged.join(", ")}`);
}
const skipped = conflictedAll.filter((path) => !staged.includes(path));
if (skipped.length > 0)
  throw new Error(
    `left unmerged (not regenerated on this Node ${process.version}): ${skipped.join(", ")}; run \`pnpm regen\` on Node ${nodePin} to regenerate them`,
  );
