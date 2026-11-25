#!/usr/bin/env node
// pnpm preflight: the checks of CI's code_quality job (.github/workflows/ci.yml), in the same order, so a push
// that would fail that job fails here first. Every expensive CI lane waits on code_quality. Each check runs even
// after an earlier one failed, so one run names every failure; the exit status is 1 if any failed.
// tests/harness/ci-preflight.test.ts keeps this list and the job's steps the same.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The code_quality job's checks after `pnpm install`: each step's `run` and `env`. */
export const preflightChecks = [
  { run: "pnpm format:check" },
  { run: "pnpm lint" },
  {
    run: "[ ! -f scripts/check-relocated-runtime-headers.mjs ] || node scripts/check-relocated-runtime-headers.mjs",
  },
  { run: "pnpm test:ts7 --baselines-only" },
  { run: "pnpm build" },
  {
    run: "pnpm test tests/harness/code-quality.test.ts tests/harness/ci-stack-scope.test.ts tests/harness/ci-preflight.test.ts",
    env: { SCRIPTC_TEST_WORKERS: "1" },
  },
  { run: "pnpm generate:ts7-ast --check" },
  { run: "pnpm generate:ir-fields --check" },
  { run: "pnpm generate:ir-codec --check" },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const failed = [];
  for (const { run, env } of preflightChecks) {
    const started = Date.now();
    console.log(`\n> ${run}`);
    const result = spawnSync(run, {
      cwd: root,
      shell: true,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status === 0) console.log(`ok ${run} (${seconds}s)`);
    else {
      console.log(`FAILED ${run} (${seconds}s)`);
      failed.push(run);
    }
  }
  if (failed.length > 0) {
    console.log(`\npreflight: ${failed.length} of ${preflightChecks.length} checks failed:`);
    for (const run of failed) console.log(`  ${run}`);
    if (failed.includes("pnpm format:check")) console.log("Run pnpm format to fix the formatting.");
    process.exit(1);
  }
  console.log(`\npreflight: all ${preflightChecks.length} checks passed`);
}
