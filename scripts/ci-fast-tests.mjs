#!/usr/bin/env node
// The tests a pull request's fast tier runs (fast_tests in .github/workflows/ci.yml).
//
// Four selections, all change-driven and none of them ever empty:
//
//   1. vitest related   for changed TypeScript sources: the tests the module
//                       graph says import them, run directly by vitest.
//   2. stem matches     the test files named after the changed sources, the
//                       cheap historical rule, kept for C and runtime files.
//   3. corpus map       changed runtime C and compiler sources mapped to the
//                       corpus programs that import the Node module they
//                       serve (node:http, node:tls, node:fs, ...), run
//                       through the differential suite with -t.
//   4. smoke corpus     when 1-3 select nothing: a curated ~3-minute corpus
//                       slice spanning the major runtime subsystems, so a
//                       pull request that touches nothing we can map still
//                       runs real programs instead of a green no-op.
//
// The expensive tier runs everything once both Vercel reviews pass
// (ci-review-gate.yml).
//
// usage: node scripts/ci-fast-tests.mjs --base <sha> --head <sha> [--dry-run]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileExclusions,
  memoryHeavyFiles,
  nativeFrontendFiles,
  testCosts,
} from "./ci-test-plan.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Single-worker milliseconds of the selected files, from scripts/ci-test-costs.json; the job runs four workers,
// so this is about five minutes of wall time.
export const FAST_TEST_BUDGET_MS = 20 * 60_000;

// The curated smoke slice's own budget. It is smaller than the fast tier's:
// a fallback, not the tier.
export const SMOKE_BUDGET_MS = 3 * 60_000;

// The corpus suites, the isolated and case-sharded suites, and the memory-heavy files run only in the expensive
// tier: any one of them takes longer than the fast tier.
const expensiveOnly = new Set([
  ...fileExclusions,
  ...nativeFrontendFiles,
  ...Object.keys(memoryHeavyFiles),
]);

const isTest = (file) => file.endsWith(".test.ts");

/** The stem a source and its tests share: packages/compiler/src/backend/emit-call.ts -> emit-call. */
const stem = (file) => basename(file).replace(/(\.test)?\.(c|h|ts|mts|mjs|cjs|js)$/, "");

/** A ~3-minute slice spanning the runtime's major subsystems, by measured
 * cost (tests/harness/corpus-costs.json). Used only when nothing else matched:
 * every PR runs these rather than a green no-op. */
export const SMOKE_CORPUS = [
  "http-client-finished-flag.ts",
  "tls-check-server-identity-malformed.ts",
  "5632-promisify-dns.ts",
  "map-fs-watcher-values.ts",
  "crypto-sign-listener-cycle.ts",
  "util-format-json-error-added-properties.ts",
  "promise-all-settled-undefined.ts",
  "fs-stream-erased-open-listener.ts",
  "9477-child-signal-mask-start.ts",
  "url-namespace-functions.ts",
  "1610-path-win32-full.ts",
  "8913-regexp-method-values-typed.ts",
  "2562-intl-numberformat-en-us.ts",
  "sqlite-return-arrays.ts",
  "math-random-worker-streams.ts",
  "record-view-class-instance.ts",
  "nullish-empty-array-default.ts",
  "4477-buffer-write-ascii-runs.ts",
  "fetch-cache-request-headers.ts",
  "9437-zlib-input-of-several-kinds.ts",
  "dgram-lookup-capture.ts",
  "net-socket-chaining.ts",
  "optional-string-compound-accessor.ts",
  "typed-argument-number-key.ts",
  "2975-bigint-default-radix.ts",
];

/** The Node builtins a changed source's name points at. `scr_child.c` is
 * `node:child_process`, `scr_worker.c` is `node:worker_threads`, and a
 * compiler file such as `lib-http2.ts` or `builtin-signatures/fs.ts` names
 * its module directly. Tokens without a module (lower, emit, ir, ...) match
 * nothing here and fall through to the smoke slice. */
const MODULE_ALIASES = {
  child: ["child_process"],
  worker: ["worker_threads"],
  event: ["events"],
  events: ["events"],
  perf: ["perf_hooks"],
  string: ["string_decoder"],
  process: ["process"],
  timers: ["timers"],
  intl: ["intl"],
  regex: ["regexp"],
  regexp: ["regexp"],
  crypto: ["crypto"],
  http: ["http", "https"],
  http2: ["http2"],
  fetch: ["http", "https", "undici"],
  tcp: ["net"],
  dgram: ["dgram"],
};

/** Every Node module name a changed file's path tokens can name. */
export function moduleTokens(file) {
  const name = basename(file).replace(/\.(c|h|ts|mts|mjs|cjs|js)$/, "");
  const tokens = new Set(
    name
      .split(/[-_.]/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 1),
  );
  const modules = new Set();
  for (const token of tokens)
    for (const module of MODULE_ALIASES[token] ?? [token]) modules.add(module);
  return modules;
}

/** module -> the corpus programs whose entry imports it. Built once per run
 * from the corpus sources; a corpus program can import several. */
export function corpusModuleIndex(corpusDir) {
  const entries = [
    ...globSync(join(corpusDir, "*.{ts,js,mjs,cjs}")),
    ...globSync(join(corpusDir, "*/main.{ts,js,mjs,cjs}")),
  ].sort();
  const index = new Map();
  for (const entry of entries) {
    let source;
    try {
      source = readFileSync(entry, "utf8");
    } catch {
      continue;
    }
    const program = relative(corpusDir, entry).replaceAll("\\", "/");
    const seen = new Set();
    for (const match of source.matchAll(
      /(?:from\s*|require\(\s*|import\(\s*)["'](?:node:)?([a-z][a-z0-9_]*(?:\/[a-z0-9_.-]+)?)["']/g,
    )) {
      const module = match[1].split("/")[0];
      if (seen.has(module)) continue;
      seen.add(module);
      const programs = index.get(module) ?? index.set(module, []).get(module);
      programs.push(program);
    }
  }
  return index;
}

/**
 * The fast tier's test files and corpus programs for the changed paths,
 * cheapest first, within their budgets.
 * `testFiles` lists every test file in the repository; `costs` maps a test
 * file to its single-worker milliseconds (a file without a measurement
 * weighs as much as the median measured one). `related` are the test files
 * vitest related already ran for this change. `corpusIndex` maps a Node
 * module to the corpus programs importing it, and `corpusCosts` maps a
 * corpus program to its single-worker milliseconds.
 */
export function fastTests(changed, testFiles, costs, budget = FAST_TEST_BUDGET_MS, options = {}) {
  const {
    related = [],
    corpusIndex = new Map(),
    corpusCosts = {},
    corpusBudget = SMOKE_BUDGET_MS,
  } = options;
  const byStem = new Map();
  for (const file of testFiles) {
    const key = stem(file);
    byStem.set(key, [...(byStem.get(key) ?? []), file]);
  }
  const alreadyRun = new Set(related);
  const relatedFiles = related.filter((file) => !expensiveOnly.has(file));
  const staticSelection = new Set();
  for (const file of changed) {
    if (isTest(file)) {
      if (testFiles.includes(file)) staticSelection.add(file);
      continue;
    }
    if (!/^(packages|scripts|tests\/harness)\//.test(file)) continue;
    for (const test of byStem.get(stem(file)) ?? []) staticSelection.add(test);
  }
  for (const file of alreadyRun) staticSelection.delete(file);

  const known = Object.values(costs).sort((a, b) => a - b);
  const median = known.length === 0 ? 0 : known[Math.floor(known.length / 2)];
  const weigh = (file) => costs[file] ?? median;
  const selected = [];
  const deferred = [];
  let total = 0;
  for (const file of [...staticSelection].sort(
    (a, b) => weigh(a) - weigh(b) || a.localeCompare(b),
  )) {
    if (expensiveOnly.has(file) || total + weigh(file) > budget) deferred.push(file);
    else {
      selected.push(file);
      total += weigh(file);
    }
  }

  // The subsystem map: corpus programs that import the module a changed
  // runtime/compiler source serves.
  const corpusSet = new Set();
  for (const file of changed) {
    if (isTest(file) || !/^(packages\/runtime\/src|packages\/compiler\/src)\//.test(file)) continue;
    for (const module of moduleTokens(file))
      for (const program of corpusIndex.get(module) ?? []) corpusSet.add(program);
  }
  const corpusKnown = Object.values(corpusCosts).sort((a, b) => a - b);
  const corpusMedian =
    corpusKnown.length === 0 ? 0 : corpusKnown[Math.floor(corpusKnown.length / 2)];
  const corpusWeigh = (program) => corpusCosts[program] ?? corpusMedian;
  const corpus = [];
  const deferredCorpus = [];
  let corpusTotal = 0;
  for (const program of [...corpusSet].sort(
    (a, b) => corpusWeigh(a) - corpusWeigh(b) || a.localeCompare(b),
  )) {
    if (corpusTotal + corpusWeigh(program) > corpusBudget) deferredCorpus.push(program);
    else {
      corpus.push(program);
      corpusTotal += corpusWeigh(program);
    }
  }

  // Never select zero tests. If related and both maps found nothing, run the
  // smoke slice: real corpus programs, on a 3-minute budget.
  let smoke = false;
  if (relatedFiles.length === 0 && selected.length === 0 && corpus.length === 0) {
    smoke = true;
    for (const program of SMOKE_CORPUS) {
      if (corpusTotal + corpusWeigh(program) > corpusBudget) deferredCorpus.push(program);
      else {
        corpus.push(program);
        corpusTotal += corpusWeigh(program);
      }
    }
  }

  return {
    related: relatedFiles,
    selected,
    deferred,
    corpus,
    deferredCorpus,
    total,
    corpusTotal,
    smoke,
  };
}

/** Runs `vitest related` for the changed TS files, excluding the expensive
 * suites so the fast tier cannot pull one in through the import graph. The
 * JSON reporter names the files it ran; those are not selected again. */
function runRelated(changedTs) {
  if (changedTs.length === 0) return { status: 0, files: [] };
  const outputFile = join(tmpdir(), `scriptc-fast-related-${process.pid}.json`);
  const args = [
    "exec",
    "vitest",
    "related",
    "--run",
    "--passWithNoTests",
    "--reporter=json",
    `--outputFile=${outputFile}`,
    ...[...expensiveOnly].flatMap((file) => [`--exclude=${file}`]),
    ...changedTs,
  ];
  const result = spawnSync("pnpm", args, { cwd: repoRoot, stdio: "inherit" });
  let files = [];
  try {
    const report = JSON.parse(readFileSync(outputFile, "utf8"));
    files = (report.testResults ?? []).map((entry) => relative(repoRoot, entry.name));
  } catch {
    /* a crashed run reports through its status below */
  }
  return { status: result.status ?? 1, files };
}

async function main() {
  const index = process.argv.indexOf("--base");
  const base = index === -1 ? undefined : process.argv[index + 1];
  const headIndex = process.argv.indexOf("--head");
  const head = headIndex === -1 ? undefined : process.argv[headIndex + 1];
  if (!base || !head)
    throw new Error("usage: ci-fast-tests.mjs --base <sha> --head <sha> [--dry-run]");
  const dryRun = process.argv.includes("--dry-run");
  const changed = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file !== "" && existsSync(new URL(`../${file}`, import.meta.url)));
  const testFiles = globSync(["packages/*/{src,test}/**/*.test.ts", "tests/harness/**/*.test.ts"], {
    cwd: repoRoot,
    exclude: (path) => path.includes("node_modules"),
  }).sort();
  const corpusCosts = JSON.parse(
    readFileSync(join(repoRoot, "tests/harness/corpus-costs.json"), "utf8"),
  ).plain;
  const corpusIndex = corpusModuleIndex(join(repoRoot, "tests/corpus"));
  const changedTs = changed.filter(
    (file) => /\.[cm]?tsx?$/.test(file) && !isTest(file) && !file.endsWith(".d.ts"),
  );
  const relatedRun = dryRun ? { status: 0, files: [] } : runRelated(changedTs);
  const selection = fastTests(changed, testFiles, testCosts.plain, FAST_TEST_BUDGET_MS, {
    related: relatedRun.files,
    corpusIndex,
    corpusCosts,
  });

  const ranRelated = selection.related.length;
  console.log(
    `${changed.length} changed files; ` +
      `${ranRelated} related + ${selection.selected.length} stem/vitest test files ` +
      `(~${Math.round((selection.total + selection.corpusTotal) / 60_000)} single-worker minutes) ` +
      `and ${selection.corpus.length} corpus programs${selection.smoke ? " (smoke fallback)" : ""}`,
  );
  for (const file of selection.related) console.log(`  related  ${file}`);
  for (const file of selection.selected) console.log(`  test     ${file}`);
  for (const program of selection.corpus) console.log(`  corpus   ${program}`);
  if (selection.deferred.length > 0) {
    console.log(`Left to the expensive tier (expensive suites or over the budget):`);
    for (const file of selection.deferred) console.log(`  ${file}`);
  }
  if (selection.deferredCorpus.length > 0)
    console.log(
      `${selection.deferredCorpus.length} mapped corpus programs over the smoke budget wait for the expensive tier`,
    );
  if (dryRun) {
    process.exitCode = relatedRun.status;
    return;
  }

  let failed = relatedRun.status !== 0;
  if (selection.selected.length > 0) {
    const result = spawnSync("pnpm", ["test", ...selection.selected], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    failed ||= (result.status ?? 1) !== 0;
  }
  if (selection.corpus.length > 0) {
    // The differential suite is case-selected by test name (the program's
    // repo-relative path), so -t chooses exactly the mapped programs.
    // -t matches the full name, which the suite prefixes with its describe
    // header, so anchor at the end only.
    const pattern = selection.corpus.map((program) =>
      program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const result = spawnSync(
      "pnpm",
      ["test", "tests/harness/differential.test.ts", "-t", `(?:${pattern.join("|")})$`],
      { cwd: repoRoot, stdio: "inherit" },
    );
    failed ||= (result.status ?? 1) !== 0;
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
