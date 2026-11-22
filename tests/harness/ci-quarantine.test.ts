import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { failedTests } from "../../scripts/ci-flakes.mjs";
import { failureReport } from "../../scripts/ci-failure-reporter.mjs";
import {
  expiredEntries,
  loadQuarantine,
  quarantineEntry,
  quarantineVerdict,
} from "../../scripts/ci-quarantine.mjs";
import { settleTask } from "../../scripts/ci-test.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const entries = loadQuarantine();
const entry = {
  test: "flaky.ts",
  files: ["tests/harness/differential.test.ts", "tests/harness/llvm-differential.test.ts"],
  owner: "someone",
  reason: "a race",
  added: "2026-11-22",
  expires: "2026-12-06",
  evidence: ["run 1 job 2"],
};
const failure = (name: string, file = "tests/harness/llvm-differential.test.ts") => ({
  file,
  name,
  fullName: `llvm differential corpus (12 programs, shard 3/20) > ${name}`,
});

test("every quarantine entry names its test, files, owner, reason, evidence and an expiry within 30 days", () => {
  expect(entries.length).toBeGreaterThan(0);
  // A short list: the quarantine holds tests while they are fixed, not for good.
  expect(entries.length).toBeLessThanOrEqual(20);
  const day = 24 * 60 * 60 * 1000;
  const keys = new Set<string>();
  for (const e of entries) {
    expect(Object.keys(e).sort(), e.test).toEqual(
      ["added", "evidence", "expires", "files", "owner", "reason", "test"].sort(),
    );
    expect(e.test.length, "test").toBeGreaterThan(0);
    expect(e.owner.trim().length, `${e.test}: owner`).toBeGreaterThan(0);
    expect(e.reason.trim().length, `${e.test}: reason`).toBeGreaterThan(0);
    expect(e.evidence.length, `${e.test}: evidence`).toBeGreaterThan(0);
    for (const file of e.files) {
      expect(existsSync(join(repoRoot, file)), `${e.test}: ${file}`).toBe(true);
      const key = `${file} > ${e.test}`;
      expect(keys.has(key), key).toBe(false);
      keys.add(key);
    }
    for (const date of [e.added, e.expires]) expect(date, e.test).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const span = Date.parse(e.expires) - Date.parse(e.added);
    expect(span, `${e.test}: expires after it was added`).toBeGreaterThanOrEqual(0);
    expect(span, `${e.test}: expires within 30 days of being added`).toBeLessThanOrEqual(30 * day);
  }
});

test("a corpus program's entry names a corpus program that exists", () => {
  for (const e of entries.filter((e) => e.files.some((file) => file.includes("differential"))))
    expect(existsSync(join(repoRoot, "tests/corpus", e.test)), e.test).toBe(true);
});

test("a task passes only when every failure is a quarantined test", () => {
  const ok = quarantineVerdict({ tests: [failure("flaky.ts")], other: [] }, [entry], "2026-11-30");
  expect(ok.pass).toBe(true);
  expect(ok.quarantined.map((q) => q.entry)).toEqual([entry]);
  // The same test in another file is not covered.
  expect(
    quarantineVerdict(
      { tests: [failure("flaky.ts", "tests/harness/npm.test.ts")], other: [] },
      [entry],
      "2026-11-30",
    ).pass,
  ).toBe(false);
  // One failure the quarantine does not hold fails the task.
  const mixed = quarantineVerdict(
    { tests: [failure("flaky.ts"), failure("steady.ts")], other: [] },
    [entry],
    "2026-11-30",
  );
  expect(mixed.pass).toBe(false);
  expect(mixed.failed.map((f) => f.name)).toEqual(["steady.ts"]);
  // Errors outside a test, a missing report and a failed process with no failed test never pass.
  expect(
    quarantineVerdict(
      { tests: [failure("flaky.ts")], other: ["unhandled error: boom"] },
      [entry],
      "2026-11-30",
    ).pass,
  ).toBe(false);
  expect(quarantineVerdict(undefined, [entry], "2026-11-30").pass).toBe(false);
  expect(quarantineVerdict({ tests: [], other: [] }, [entry], "2026-11-30").pass).toBe(false);
});

test("an entry lapses after its expiry date", () => {
  expect(quarantineEntry(failure("flaky.ts"), [entry], "2026-12-06")).toBe(entry);
  expect(quarantineEntry(failure("flaky.ts"), [entry], "2026-12-07")).toBeUndefined();
  expect(
    quarantineVerdict({ tests: [failure("flaky.ts")], other: [] }, [entry], "2026-12-07").pass,
  ).toBe(false);
  expect(expiredEntries([entry], "2026-12-07")).toEqual([entry]);
  expect(expiredEntries([entry], "2026-12-06")).toEqual([]);
});

test("the CI runner passes a task whose only failures are quarantined, with a warning for each", () => {
  const lines: string[] = [];
  const settle = (code: number | null, signal: string | null, report: unknown) =>
    settleTask({
      name: "case-sharded corpus",
      code,
      signal,
      report,
      entries: [entry],
      date: "2026-11-30",
      log: (line: string) => lines.push(line),
    });
  expect(() => settle(0, null, undefined)).not.toThrow();
  expect(() => settle(1, null, { tests: [failure("flaky.ts")], other: [] })).not.toThrow();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(
    /^::warning title=Quarantined flaky test::tests\/harness\/llvm-differential/,
  );
  expect(lines[0]).toContain("until 2026-12-06 (owner someone: a race)");
  expect(() => settle(1, null, { tests: [failure("steady.ts")], other: [] })).toThrow(
    "case-sharded corpus exited with 1",
  );
  // A killed process never passes, whatever its report says.
  expect(() => settle(null, "SIGKILL", { tests: [failure("flaky.ts")], other: [] })).toThrow(
    "exited with SIGKILL",
  );
});

test("the failure reporter records failed tests by file and name, and every error outside a test", () => {
  // `errors` is how many errors the result holds, `bodyErrors` how many the body threw
  // (scripts/ci-quarantine-runner.mjs).
  const testCase = (name: string, state: string, errors = 0, bodyErrors?: number) => ({
    name,
    fullName: `suite > ${name}`,
    result: () => ({ state, errors: Array.from({ length: errors }, () => ({ message: "x" })) }),
    meta: () => (bodyErrors === undefined ? {} : { scriptcBodyErrors: bodyErrors }),
  });
  const testModule = (
    file: string,
    state: string,
    tests: ReturnType<typeof testCase>[],
    errors: { message: string }[] = [],
    suiteErrors: { message: string }[] = [],
  ) => ({
    moduleId: join(repoRoot, file),
    state: () => state,
    errors: () => errors,
    children: {
      allTests: () => tests,
      allSuites: () => [{ fullName: "suite", errors: () => suiteErrors }],
    },
  });
  const report = failureReport(
    [
      testModule("tests/harness/a.test.ts", "failed", [
        testCase("passes", "passed"),
        testCase("fails", "failed", 1, 1),
        // Failed on both attempts of a retry, each time in its body.
        testCase("fails twice", "failed", 2, 2),
        // A beforeEach hook threw: the body never ran.
        testCase("hook before", "failed", 1),
        // The body threw and then an afterEach hook threw too.
        testCase("hook after", "failed", 2, 1),
        // A soft assertion or an assertion count failed it; the body threw nothing.
        testCase("soft", "failed", 1, 0),
      ]),
      testModule("tests/harness/b.test.ts", "failed", [], [{ message: "cannot load\nstack" }]),
      testModule(
        "tests/harness/c.test.ts",
        "failed",
        [testCase("skipped", "skipped")],
        [],
        [{ message: "beforeAll failed" }],
      ),
    ],
    [{ message: "unhandled rejection" }],
    repoRoot,
  );
  expect(report.tests).toEqual([
    { file: "tests/harness/a.test.ts", name: "fails", fullName: "suite > fails" },
    { file: "tests/harness/a.test.ts", name: "fails twice", fullName: "suite > fails twice" },
  ]);
  const outside = "came from outside its body (a hook, an assertion count or a soft assertion)";
  expect(report.other).toEqual([
    "unhandled error: unhandled rejection",
    `tests/harness/a.test.ts > suite > hook before: 1 of its 1 errors ${outside}`,
    `tests/harness/a.test.ts > suite > hook after: 1 of its 2 errors ${outside}`,
    `tests/harness/a.test.ts > suite > soft: 1 of its 1 errors ${outside}`,
    "tests/harness/b.test.ts: cannot load",
    "tests/harness/c.test.ts > suite: beforeAll failed",
    "tests/harness/c.test.ts: failed without a failed test",
  ]);
  expect(failureReport([], [], repoRoot, "interrupted").other).toEqual(["the run was interrupted"]);
});

test("ci-flakes reads the failed tests from a job log", () => {
  const esc = String.fromCharCode(27);
  const log = [
    "2026-11-21T16:28:48.3335194Z  FAIL  tests/harness/llvm-differential.test.ts > llvm differential corpus (374 programs, dev, shard 17/20) > worker-message-map-set.ts",
    `2026-11-21T16:28:48.3335194Z ${esc}[31m FAIL ${esc}[39m tests/harness/npm-static.test.ts > npm-static pilots > the published Effect generator logs and completes statically`,
    "2026-11-21T16:28:48.3335194Z  ✓ tests/harness/three.test.ts (3 tests) 1234ms",
  ].join("\n");
  const found = failedTests(log);
  expect(found.map((f) => [f.file, f.name])).toEqual([
    ["tests/harness/llvm-differential.test.ts", "worker-message-map-set.ts"],
    [
      "tests/harness/npm-static.test.ts",
      "the published Effect generator logs and completes statically",
    ],
  ]);
  // Each failed test it finds is matched against the quarantine as the runner matches it.
  expect(quarantineEntry(found[0]!, entries, "2026-11-22")?.test).toBe("worker-message-map-set.ts");
});

test("the quarantine file says how entries work", () => {
  const { note } = JSON.parse(
    readFileSync(join(repoRoot, "tests/harness/flaky-quarantine.json"), "utf8"),
  ) as { note: string };
  expect(note).toContain("scripts/ci-quarantine.mjs");
});
