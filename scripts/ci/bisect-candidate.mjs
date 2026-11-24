#!/usr/bin/env node
// Runs the failing tests at one commit, for the culprit search (.github/workflows/bisect-main.yml). The job that
// calls it has checked out the commit and built it; this runs only the reported tests, so a probe is minutes.
//
// usage: node scripts/ci/bisect-candidate.mjs --specs specs.json [--repeat 1] [--out result.json]
//        [--root <checkout>] [--expect pass|fail]
// Exit: 0 when every run passed, 1 when a test failed, 125 when the run could not produce an answer (an
// infrastructure failure, which the search treats as neither a pass nor a failure).
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * A regex that matches exactly this test's full name. The failure reporter joins a suite and its test with
 * " > "; Vitest's `--testNamePattern` matches the name joined with spaces, so a "suite > test" pattern would
 * match nothing and a real failure would look like a flake.
 */
export function testNamePattern(fullName) {
  const escaped = String(fullName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Accept the reporter's "suite > test" and the space-joined form Vitest filters on, so nested tests are never
  // dropped (a dropped failure would look like a pass).
  return `^${escaped.replaceAll(" > ", "(?: > | )")}$`;
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

/**
 * Whether every reported test meets a confirmation expectation, with three runs each: pass = three zero exits,
 * fail = three test failures and no infrastructure error. A single flake or a runner failure must never confirm a
 * culprit, and a run with several failing tests must satisfy the expectation for every one of them.
 */
export function meetsExpectation(expect, groups) {
  if (!Array.isArray(groups) || groups.length === 0) return false;
  const holds =
    expect === "pass"
      ? (codes) => codes.length === 3 && codes.every((code) => code === 0)
      : expect === "fail"
        ? (codes) =>
            codes.length === 3 &&
            codes.every((code) => Number.isInteger(code) && code > 0 && code < 125)
        : null;
  if (holds === null) throw new Error(`unknown expectation ${JSON.stringify(expect)}`);
  return groups.every(holds);
}

/**
 * Groups a runner's attempts by the test and flavor each ran: the same test can fail in both the plain and the
 * sanitized lane, and each lane's three runs are a confirmation of their own.
 */
export function runsBySpec(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.spec.file}\u0000${run.spec.fullName ?? ""}\u0000${run.spec.san ? "san" : "plain"}`;
    const group = groups.get(key) ?? groups.set(key, []).get(key);
    group.push(run.code);
  }
  return [...groups.values()];
}

/** Whether a set of process exit codes means the tests passed, failed, or could not be judged. */
export function outcome(codes) {
  if (codes.length === 0 || codes.some((code) => code === null || code >= 126)) return "infra";
  return codes.every((code) => code === 0) ? "pass" : "fail";
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  // The runner may be copied out of the repository (a probe checks out an older commit that predates it), so the
  // checkout it tests is named explicitly.
  const root = option("--root") ?? fileURLToPath(new URL("../../", import.meta.url));
  const specs = JSON.parse(readFileSync(option("--specs"), "utf8"));
  const repeat = Number(option("--repeat") ?? "1");
  const expect = option("--expect");
  const runs = [];
  for (const spec of specs)
    for (let attempt = 0; attempt < repeat; attempt++) {
      const result = spawnSync("pnpm", commandFor(spec), {
        cwd: root,
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
  const codes = runs.map((run) => run.code);
  // Each reported test's three runs are judged together, per lane: several failing tests (or both flavors of one
  // test) each need their own 3/3.
  const holds = expect === undefined ? undefined : meetsExpectation(expect, runsBySpec(runs));
  const answer = outcome(codes);
  const result = {
    pass: answer === "pass",
    infra: answer === "infra",
    ...(expect === undefined ? {} : { expected: expect, holds }),
    specs,
    runs: runs.map(({ spec, code }) => ({ file: spec.file, fullName: spec.fullName, code })),
  };
  if (option("--out")) writeFileSync(option("--out"), JSON.stringify(result));
  console.log(JSON.stringify(result));
  process.exitCode =
    expect !== undefined ? (holds ? 0 : 1) : answer === "pass" ? 0 : answer === "fail" ? 1 : 125;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
