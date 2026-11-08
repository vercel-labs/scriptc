#!/usr/bin/env node
// Decides which expensive CI lanes a pull request needs, from the files it changes since the merge base.
//
// Usage: node ci-lanes.mjs --base <sha> --head <sha> [--pr <number>] [--github-output]
//
// CI runs the base branch's copy of this script against the pull request's diff, so a pull request cannot widen its
// own exemptions; a change to this script runs every lane until it is on the base branch. It uses only Node and git.
//
// Lanes (each an output, true or false):
// - linux: the Linux build and test shards, the TypeScript 7 parity sweep and the smaller Linux, Windows and Android
//   jobs. Off only when every change is documentation.
// - macos: the macOS native build, the darwin test shards, the macOS LLVM artifact jobs and the iOS runtime packs. On
//   when the change touches a darwin package, a path naming darwin, macOS, iOS, Mach-O or kqueue, the runtime's
//   platform header, the darwin suite's test files (scripts/ci-test-plan.mjs), the LLVM helper (native/,
//   packages/llvm-*) or the shared runtime pack code, or changed lines in packages/{runtime,compiler,cli} that mention
//   darwin-specific APIs (__APPLE__, kqueue, Mach-O and similar).
// - effects: the Effect suites. On when the change touches their harness or fixtures. A change to compiler or runtime
//   sources, or to the LLVM helper, also turns the lane on, but for one of its sixteen shards per flavor
//   (effect_shards, chosen by the pull request's number): the one break the full lane caught on main in a week
//   failed every shard, and the full lane costs sixteen times as much. Pushes to main run all of it.
// - bootstrap: the native bootstrap seed and self-rebuild contracts. On when the change touches the bootstrap scripts,
//   the native CLI build, the cli-* packages or the self-hosting tests.
// - profile: the native compiler profile check. On when the change touches the compiler's sources or its committed
//   layout and profile, the native code generation it is compiled with, the LLVM helper package, or the native CLI
//   build, any of which can leave the committed profile describing functions that no longer match. Compiler tests are
//   not part of the compiler it builds, so they do not turn it on. The same job holds that build to the self-compile
//   budget, so a change to the budget or to one of its scripts (the judge, the heap probe) turns it on too.
// - islands: the Node island conformance lane (tests/harness/island-conformance.test.ts), which builds every package
//   program again with each package forced into a Node island. On when the change touches the island decision
//   (packages/compiler/src/node-islands), the boundary lowering, the island runtime units and their host scripts, the
//   libnode bridge, or the lane itself and the programs and packages it runs (the npm suite's fixtures, the pinned
//   packages, and a corpus program's own node_modules).
// Every lane is on when the change touches CI configuration, the workspace manifests or lockfile, vitest
// configuration, the shared test harness modules or this script, or when the diff cannot be computed. Pushes to main,
// merge queue groups, the nightly sweep and manual runs do not use this script: pushes to main and merge queue groups
// run every lane except macos, and the others run every lane.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const lanes = ["linux", "macos", "effects", "bootstrap", "profile", "islands"];

const everything = [
  /^\.github\//,
  /^scripts\/ci-/,
  /^scripts\/bootstrap-seed\.mjs$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.node-version$/,
  /^patches\//,
  /^vitest\.config\.ts$/,
  /^tests\/harness\/(shard\.ts|shard-balance\.mjs|suite-lock\.mjs)$/,
  /^packages\/[^/]+\/package\.json$/,
];
const documentation = [/^docs\//, /\.mdx?$/, /^LICENSE$/, /^CHANGELOG\.md$/];
const darwinPath = /darwin|macos|ios|apple|mach-?o|kqueue/i;
// Native code generation and runtime packs every platform shares.
const sharedNative = /^native\/|^packages\/(llvm-[^/]+|runtime-pack-common)\//;
// The darwin suite's files (darwinCorpusFiles and darwinFiles in scripts/ci-test-plan.mjs), the LLVM differential
// the macOS artifact jobs run, the runtime's platform header, and the installation check only the macOS contracts
// job runs.
const darwinFiles = [
  "packages/cli/test/bootstrap.test.ts",
  "packages/cli/test/native-link-info.test.ts",
  "packages/cli/test/native-output.test.ts",
  "packages/cli/test/runtime-pack.test.ts",
  "packages/compiler/test/debug-variables.test.ts",
  "packages/compiler/test/native-codegen-integration.test.ts",
  "packages/compiler/test/source-debugging.test.ts",
  "packages/runtime-darwin-arm64/test/archive.test.ts",
  "packages/runtime/src/scr_alloc.test.ts",
  "packages/runtime/src/scr_platform.h",
  "packages/runtime/test/string.test.ts",
  "scripts/smoke-libnode-opt-in.mjs",
  "tests/harness/differential.test.ts",
  "tests/harness/executable-hardening.test.ts",
  "tests/harness/ffi-callback-pool.test.ts",
  "tests/harness/ffi-catalog.test.ts",
  "tests/harness/ffi-frameworks.test.ts",
  "tests/harness/library-callbacks.test.ts",
  "tests/harness/library-dispatch.test.ts",
  "tests/harness/library-multi.test.ts",
  "tests/harness/native-object-example.test.ts",
  "tests/harness/runtime-tree-shaking.test.ts",
  "tests/harness/terminal-geometry.test.ts",
  "tests/harness/llvm-differential.test.ts",
];
const darwinLine =
  /__APPLE__|__MACH__|TARGET_OS_|kqueue|kevent|\bdarwin\b|Darwin|Mach-?O|macho|MachO|mach_|dyld|CoreFoundation|libSystem/;
const effectPath = /^tests\/(harness\/effect|fixtures\/effect)/;
// What compiles and runs the Effect fixtures: compiler and runtime sources and the LLVM helper.
const effectSamplePath = /^packages\/(compiler|runtime)\/src\/|^native\//;
// The Effect job's shards (SCRIPTC_TEST_SHARD i/16 in .github/workflows/ci.yml).
export const effectShardCount = 16;
const bootstrapPath =
  /^scripts\/(bootstrap-seed|ci-native-bootstrap|build-native-cli)|^packages\/cli-[^/]+\/|^tests\/harness\/(self-hosting|bootstrap-seed|ci-native-bootstrap|native-cli-packaging)/;
// The native compiler's own functions: its sources, the code generation they
// are compiled with, and the build that compiles them.
const profilePath =
  /^packages\/compiler\/(src|native)\/|^native\/|^packages\/llvm-[^/]+\/|^scripts\/(build-native-cli|self-compile-)/;

// Where a Node island is decided, lowered, run and tested package by package.
const islandPath =
  /^packages\/compiler\/src\/node-islands\/|^packages\/compiler\/src\/frontend\/lowering\/[^/]*node-island|^packages\/runtime\/src\/scr_node_|^packages\/libnode-[^/]+\/|^tests\/harness\/(island-conformance|npm-suite\.ts|npm-cases\.ts|libnode\.ts)|^tests\/fixtures\/(island-conformance|npm|commander-calc)\/|^tests\/corpus\/[^/]+\/node_modules\//;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

/** The lanes a list of changed files needs, with the reason for each lane that is on. `effectShards` says how
 * much of the effects lane runs when it is on: "all", or "sample" for one shard per flavor. */
export function select(files, changedLines) {
  const on = Object.fromEntries(lanes.map((lane) => [lane, false]));
  const reasons = [];
  let everyEffectShard = false;
  const all = (why) => {
    for (const lane of lanes) on[lane] = true;
    everyEffectShard = true;
    reasons.push(`${why}: every lane`);
  };
  for (const file of files) {
    if (everything.some((re) => re.test(file))) {
      all(file);
      continue;
    }
    if (documentation.some((re) => re.test(file))) continue;
    on.linux = true;
    if (darwinPath.test(file) || darwinFiles.includes(file) || sharedNative.test(file)) {
      if (!on.macos) reasons.push(`${file}: macos`);
      on.macos = true;
    }
    if (effectPath.test(file)) {
      if (!everyEffectShard) reasons.push(`${file}: effects`);
      on.effects = true;
      everyEffectShard = true;
    } else if (effectSamplePath.test(file)) {
      if (!on.effects) reasons.push(`${file}: effects, one shard of ${effectShardCount}`);
      on.effects = true;
    }
    if (bootstrapPath.test(file)) {
      if (!on.bootstrap) reasons.push(`${file}: bootstrap`);
      on.bootstrap = true;
    }
    if (profilePath.test(file)) {
      if (!on.profile) reasons.push(`${file}: profile`);
      on.profile = true;
    }
    if (islandPath.test(file)) {
      if (!on.islands) reasons.push(`${file}: islands`);
      on.islands = true;
    }
  }
  const line = changedLines.find((l) => darwinLine.test(l.text));
  if (line !== undefined && !on.macos) {
    reasons.push(`${line.file}: a changed line mentions a darwin-specific API: macos`);
    on.macos = true;
  }
  if (files.length > 0 && !on.linux) reasons.push("documentation only");
  return { on, reasons, effectShards: on.effects && !everyEffectShard ? "sample" : "all" };
}

/** The Effect shards a selection runs, as the JSON list the job's matrix reads: every shard, or for a sample the
 * one the pull request's number picks, so that a pull request keeps its shard from push to push and different
 * pull requests cover different fixtures. */
export function effectShardList(effectShards, pr) {
  if (effectShards !== "sample")
    return JSON.stringify(Array.from({ length: effectShardCount }, (_, index) => index + 1));
  const number = Number(pr);
  return JSON.stringify([
    Number.isSafeInteger(number) && number > 0 ? (number % effectShardCount) + 1 : 1,
  ]);
}

/** Added and removed lines of the C, header and TypeScript sources below packages/{runtime,compiler,cli}. */
function changedLinesOf(base, head) {
  const out = git(
    "diff",
    "-U0",
    "--no-color",
    `${base}...${head}`,
    "--",
    "packages/runtime",
    "packages/compiler",
    "packages/cli",
  );
  const lines = [];
  let file = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (/^[+-](?![+-])/.test(line)) lines.push({ file, text: line.slice(1) });
  }
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const base = option("--base");
  const head = option("--head") ?? "HEAD";
  let result;
  try {
    if (!base) throw new Error("no --base");
    const files = git("diff", "--name-only", "--no-color", `${base}...${head}`)
      .split("\n")
      .filter(Boolean);
    result = select(files, changedLinesOf(base, head));
  } catch (error) {
    result = {
      on: Object.fromEntries(lanes.map((lane) => [lane, true])),
      reasons: [`diff unavailable (${error.message}): every lane`],
      effectShards: "all",
    };
  }
  const outputs = [
    ...lanes.map((lane) => `${lane}=${result.on[lane]}`),
    `effect_shards=${effectShardList(result.effectShards, option("--pr"))}`,
  ];
  for (const output of outputs) console.log(output);
  for (const reason of result.reasons) console.log(`  ${reason}`);
  if (args.includes("--github-output") && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, outputs.map((output) => `${output}\n`).join(""));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
