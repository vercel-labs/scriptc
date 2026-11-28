#!/usr/bin/env node
// The canary tier's extra tests: the suites that run on a push to canary, in its merge queue and after it merges,
// on top of the fast tier's change-selected tests. They are the compiler source-rule and snapshot suites, plus the
// tests of the CI scripts themselves, which snapshot and validate this workflow.
//
// The workflow calls `node scripts/ci/canary-suite.mjs`; anyone checking a change against canary's tier calls the
// same command, so the two run the same selection. `--list` prints the files, `--print-command` the command.
//
// usage: node scripts/ci/canary-suite.mjs [--list | --print-command]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Suites that read tests/harness/__snapshots__ are here; coverage.test.ts is the coverage lane's whole suite and
// stays out.
export const CANARY_SUITES = [
  "tests/harness/diagnostics.test.ts",
  "tests/harness/node-island-marks.test.ts",
  "tests/harness/project-config.test.ts",
  "tests/harness/library-int.test.ts",
  "tests/harness/surface-manifest.test.ts",
  "tests/harness/decl-boundary.test.ts",
  "tests/harness/workspace-source.test.ts",
  "tests/harness/source-package.test.ts",
  "tests/harness/partial-assertion-read-rule.test.ts",
  "packages/compiler/src/program-facts.test.ts",
  "tests/harness/ci-lanes.test.ts",
  "tests/harness/ci-test-plan.test.ts",
  "tests/harness/ci-bisect.test.ts",
  "tests/harness/ci-green-tag.test.ts",
  "tests/harness/ci-queue-tests.test.ts",
  "tests/harness/ci-review-gate.test.ts",
  "tests/harness/ci-merge-guard.test.ts",
  "tests/harness/ci-canary-suite.test.ts",
];

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The canary tier's suite list, in the order the runner hands it to Vitest. */
export function canarySuites() {
  return [...CANARY_SUITES];
}

/** The argv that runs the canary tier, relative to the repository root. */
export function canaryCommand() {
  return ["pnpm", "test", ...CANARY_SUITES];
}

function missingSuites() {
  return CANARY_SUITES.filter((file) => !existsSync(join(repoRoot, file)));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const file of CANARY_SUITES) console.log(file);
    return;
  }
  if (args.includes("--print-command")) {
    console.log(canaryCommand().join(" "));
    return;
  }
  const unknown = args.filter((arg) => arg !== "--");
  if (unknown.length > 0) {
    console.error(`canary-suite: unknown argument ${unknown[0]}`);
    process.exitCode = 2;
    return;
  }
  const missing = missingSuites();
  if (missing.length > 0) {
    console.error(`canary-suite: missing suite files:\n  ${missing.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  const [command, ...commandArgs] = canaryCommand();
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`canary-suite: could not run ${command}: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
