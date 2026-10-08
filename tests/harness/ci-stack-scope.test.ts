import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { requiresFullCi } from "../../scripts/ci-stack-scope.mjs";

const stacked = (base: string, position = 1) => ({
  pull_request: { base: { ref: base }, stack: { base: { ref: "main" }, position } },
});

test.each([
  ["ordinary PR", "pull_request", { pull_request: { base: { ref: "main" } } }, true],
  ["bottom layer", "pull_request", stacked("main"), true],
  ["new bottom after a merge", "pull_request", stacked("main", 2), true],
  ["upper layer", "pull_request", stacked("feature/lower", 3), false],
  ["main push", "push", {}, true],
  ["push with stack metadata", "push", stacked("feature/lower"), true],
  ["missing event", "pull_request", undefined, true],
  ["missing stack base", "pull_request", { pull_request: { stack: {} } }, true],
  ["missing PR base", "pull_request", { pull_request: { stack: { base: { ref: "main" } } } }, true],
  ["empty PR base", "pull_request", stacked(""), true],
])("CI selects the correct scope for %s", (_name, eventName, event, full) => {
  expect(requiresFullCi(eventName, event)).toBe(full);
});

type Job = {
  needs?: string | string[];
  if?: string;
  steps?: { run?: string }[];
};
const workflow = load(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };
const heavyJobs = Object.keys(workflow.jobs).filter(
  (name) => !["validation_scope", "code_quality", "test"].includes(name),
);

test("every expensive CI job is gated and included in the required test check", () => {
  for (const name of heavyJobs) {
    const job = workflow.jobs[name]!;
    expect(job.needs, name).toContain("validation_scope");
    expect(job.if, name).toBe("${{ needs.validation_scope.outputs.full == 'true' }}");
    expect(workflow.jobs.test!.needs, name).toContain(name);
  }
  expect(workflow.jobs.code_quality!.if).toBeUndefined();
  expect(workflow.jobs.test!.needs).toContain("validation_scope");
  expect(workflow.jobs.test!.needs).toContain("code_quality");
  expect(workflow.jobs.test!.if).toBe("${{ !cancelled() }}");
});

function runGate(full: string, results: Record<string, string> = {}) {
  const needs = Object.fromEntries(
    (workflow.jobs.test!.needs as string[]).map((name) => [
      name,
      {
        result:
          results[name] ?? (full === "false" && heavyJobs.includes(name) ? "skipped" : "success"),
        outputs: { full },
      },
    ]),
  );
  const script = workflow.jobs
    .test!.steps!.find((step) => step.run)!
    .run!.replace(
      /\$\{\{ needs\.(\w+)\.(result|outputs\.full) \}\}/g,
      (_expression, name: string, field: string) =>
        field === "result" ? needs[name]!.result : needs[name]!.outputs.full,
    );
  expect(script).not.toContain("${{");
  return spawnSync("bash", ["-e", "-c", script], { encoding: "utf8" }).status;
}

test("the required test check accepts a complete full run or intentionally skipped upper-layer jobs", () => {
  expect(runGate("true")).toBe(0);
  expect(runGate("false")).toBe(0);
});

test("full validation rejects any failed, cancelled or skipped expensive job", () => {
  for (const job of heavyJobs)
    for (const result of ["failure", "cancelled", "skipped"])
      expect(runGate("true", { [job]: result }), `${job}: ${result}`).not.toBe(0);
});

test("upper-layer validation cannot hide a failed or cancelled expensive job", () => {
  for (const job of heavyJobs)
    for (const result of ["failure", "cancelled"])
      expect(runGate("false", { [job]: result }), `${job}: ${result}`).not.toBe(0);
});

test("both scopes require successful planning and code quality", () => {
  for (const full of ["true", "false"])
    for (const job of ["validation_scope", "code_quality"])
      for (const result of ["failure", "cancelled", "skipped"])
        expect(runGate(full, { [job]: result }), `${full}: ${job}: ${result}`).not.toBe(0);
  for (const full of ["", "unknown"]) expect(runGate(full)).not.toBe(0);
});
