import { expect, test } from "vitest";
import CiProgressReporter, { formatDuration } from "../../scripts/ci-progress-reporter.mjs";

function fakeCase(id: string, name: string, state: string, duration: number, message?: string) {
  return {
    id,
    name,
    fullName: name,
    module: { moduleId: `${process.cwd()}/tests/harness/differential.test.ts` },
    result: () => ({ state, errors: message ? [{ message }] : [] }),
    diagnostic: () => ({ duration }),
  };
}

test("names failed and slow tests as they finish, and the running ones every interval", () => {
  let clock = 0;
  const lines: string[] = [];
  const reporter = new CiProgressReporter({
    now: () => clock,
    write: (line: string) => lines.push(line),
    intervalSeconds: 3600,
    slowSeconds: 30,
    task: "case-sharded corpus",
  });
  reporter.onTestRunStart();
  const fast = fakeCase("a", "fast", "passed", 1_000);
  const slow = fakeCase("b", "slow", "passed", 95_000);
  const broken = fakeCase("c", "broken", "failed", 2_000, "expected 1\nreceived 2");
  const hung = fakeCase("d", "hung", "pending", 0);
  for (const testCase of [fast, slow, broken, hung]) reporter.onTestCaseReady(testCase);
  clock = 100_000;
  for (const testCase of [fast, slow, broken]) reporter.onTestCaseResult(testCase);
  clock = 400_000;
  reporter.heartbeat();
  reporter.onTestRunEnd();
  expect(lines).toEqual([
    "[progress case-sharded corpus] slow 1m35s tests/harness/differential.test.ts > slow",
    "[progress case-sharded corpus] FAIL 2s tests/harness/differential.test.ts > broken: expected 1",
    "[progress case-sharded corpus] 6m40s: 3 tests finished, 1 failed; 1 running: tests/harness/differential.test.ts > hung (6m40s)",
  ]);
});

test("formats durations in minutes and seconds", () => {
  expect(formatDuration(4_400)).toBe("4s");
  expect(formatDuration(252_000)).toBe("4m12s");
});
