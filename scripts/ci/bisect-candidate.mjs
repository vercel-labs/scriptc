#!/usr/bin/env node
// Runs the failing tests at one commit, for the culprit search (.github/workflows/bisect-main.yml). The job that
// calls it has checked out the commit and built it; this runs only the reported tests, so a probe is minutes.
//
// usage: node scripts/ci/bisect-candidate.mjs --specs specs.json [--repeat 1] [--out result.json]
// Exit: 0 when every run passed, 1 when a test failed, 125 when the run could not produce an answer (an
// infrastructure failure, which the search treats as neither a pass nor a failure).
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** A regex that matches exactly this test's full name, which may hold parentheses or other syntax. */
export function testNamePattern(fullName) {
  return `^${String(fullName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** The vitest command that re-runs one reported test. */
export function commandFor(spec) {
  const args = ["exec", "vitest", "run", spec.file];
  if (spec.fullName) args.push("-t", testNamePattern(spec.fullName));
  return args;
}

/** The environment a probe needs: a sanitized failure is re-run sanitized, with leaks off as CI runs it. */
export function envFor(spec) {
  return spec.san ? { SCRIPTC_SAN: "1", ASAN_OPTIONS: "detect_leaks=0" } : {};
}

/** Whether a set of process exit codes means the tests passed, failed, or could not be judged. */
export function outcome(codes) {
  if (codes.length === 0 || codes.some((code) => code === null || code >= 126)) return "infra";
  return codes.every((code) => code === 0) ? "pass" : "fail";
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const specs = JSON.parse(readFileSync(option("--specs"), "utf8"));
  const repeat = Number(option("--repeat") ?? "1");
  const runs = [];
  for (const spec of specs)
    for (let attempt = 0; attempt < repeat; attempt++) {
      const result = spawnSync("pnpm", commandFor(spec), {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "inherit",
        env: {
          ...process.env,
          ...envFor(spec),
          SCRIPTC_TEST_WORKERS: process.env.SCRIPTC_TEST_WORKERS ?? "4",
        },
      });
      runs.push({ spec, code: result.status });
    }
  const answer = outcome(runs.map((run) => run.code));
  const result = {
    pass: answer === "pass",
    infra: answer === "infra",
    specs,
    runs: runs.map(({ spec, code }) => ({ file: spec.file, fullName: spec.fullName, code })),
  };
  if (option("--out")) writeFileSync(option("--out"), JSON.stringify(result));
  console.log(JSON.stringify(result));
  process.exitCode = answer === "pass" ? 0 : answer === "fail" ? 1 : 125;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
