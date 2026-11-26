import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { CANARY_SUITES, canaryCommand, canarySuites } from "../../scripts/ci/canary-suite.mjs";

const workflow = load(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as {
  jobs: Record<
    string,
    {
      steps?: { name?: string; if?: string; run?: string }[];
    }
  >;
};

const repoFile = (path: string) => new URL(`../../${path}`, import.meta.url);

test("the canary suites exist, are test files, and are unique", () => {
  expect(CANARY_SUITES.length).toBeGreaterThan(0);
  expect(new Set(CANARY_SUITES).size).toBe(CANARY_SUITES.length);
  for (const file of CANARY_SUITES) {
    expect(file, `${file} is a test file`).toMatch(/\.test\.ts$/);
    expect(existsSync(repoFile(file)), `${file} exists`).toBe(true);
  }
});

test("the canary tier runs through the suite script", () => {
  const steps = workflow.jobs.fast_tests!.steps ?? [];
  const step = steps.find(
    (candidate) => candidate.name === "Canary source-rule and snapshot tests",
  );
  expect(step, "the canary step is in the fast_tests job").toBeDefined();
  expect(step!.if).toContain("needs.validation_scope.outputs.tier == 'canary'");
  expect(step!.run!.trim()).toBe("node scripts/ci/canary-suite.mjs");
  // The workflow no longer names suites itself: the script is the one list both the workflow and a local run use.
  expect(step!.run).not.toContain("pnpm test");
});

test("the script builds the same command the workflow used to spell out", () => {
  expect(canaryCommand()).toEqual(["pnpm", "test", ...CANARY_SUITES]);
  expect(canarySuites()).toEqual(CANARY_SUITES);
  expect(canarySuites()).not.toBe(CANARY_SUITES);
});

test("the script lists its suites", () => {
  const result = spawnSync(
    "node",
    [new URL("../../scripts/ci/canary-suite.mjs", import.meta.url).pathname, "--list"],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual(CANARY_SUITES);
});
