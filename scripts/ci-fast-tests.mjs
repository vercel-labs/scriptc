#!/usr/bin/env node
// The tests a pull request's fast tier runs (fast_tests in .github/workflows/ci.yml): the test files the pull
// request changes, and the test files named after the sources it changes, within a time budget. The expensive tier
// runs everything once both Vercel reviews pass (ci-review-gate.yml).
//
// usage: node scripts/ci-fast-tests.mjs --base <sha> --head <sha> [--dry-run]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { basename } from "node:path";
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

/**
 * The fast tier's test files for the changed paths, cheapest first, within the budget.
 * `testFiles` lists every test file in the repository; `costs` maps a test file to its single-worker
 * milliseconds (a file without a measurement weighs as much as the median measured one).
 */
export function fastTests(changed, testFiles, costs, budget = FAST_TEST_BUDGET_MS) {
  const byStem = new Map();
  for (const file of testFiles) {
    const key = stem(file);
    byStem.set(key, [...(byStem.get(key) ?? []), file]);
  }
  const related = new Set();
  for (const file of changed) {
    if (isTest(file)) {
      if (testFiles.includes(file)) related.add(file);
      continue;
    }
    if (!/^(packages|scripts|tests\/harness)\//.test(file)) continue;
    for (const test of byStem.get(stem(file)) ?? []) related.add(test);
  }
  const known = Object.values(costs).sort((a, b) => a - b);
  const median = known.length === 0 ? 0 : known[Math.floor(known.length / 2)];
  const weigh = (file) => costs[file] ?? median;
  const selected = [];
  const deferred = [];
  let total = 0;
  for (const file of [...related].sort((a, b) => weigh(a) - weigh(b) || a.localeCompare(b))) {
    if (expensiveOnly.has(file) || total + weigh(file) > budget) deferred.push(file);
    else {
      selected.push(file);
      total += weigh(file);
    }
  }
  return { selected, deferred, total };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = arg("--base");
  const head = arg("--head");
  if (!base || !head)
    throw new Error("usage: ci-fast-tests.mjs --base <sha> --head <sha> [--dry-run]");
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
  const { selected, deferred, total } = fastTests(changed, testFiles, testCosts.plain);
  console.log(
    `${changed.length} changed files; ${selected.length} related test files (~${Math.round(total / 60_000)} single-worker minutes)`,
  );
  for (const file of selected) console.log(`  ${file}`);
  if (deferred.length > 0) {
    console.log(`Left to the expensive tier (expensive suites or over the budget):`);
    for (const file of deferred) console.log(`  ${file}`);
  }
  if (selected.length > 0 && !process.argv.includes("--dry-run")) {
    const result = spawnSync("pnpm", ["test", ...selected], { cwd: repoRoot, stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  }
}
