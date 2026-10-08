import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";

type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: { run?: string; uses?: string }[];
};
const workflow = load(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };
const scopeJob = workflow.jobs.validation_scope!;
const scopeScript = scopeJob.steps!.find((step) => step.run)!.run!;
const heavyJobs = Object.keys(workflow.jobs).filter(
  (name) => !["validation_scope", "code_quality", "test"].includes(name),
);

const repository = "vercel-labs/scriptc";
const stacked = (base: string, position = 3) => ({
  repository: { full_name: repository },
  pull_request: {
    author_association: "MEMBER",
    head: { repo: { full_name: repository } },
    base: { ref: base, repo: { full_name: repository } },
    stack: { base: { ref: "main" }, position },
  },
});
const upper = stacked("feature/lower");

function runScope(eventName: string, event: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "ci-stack-scope-"));
  try {
    const eventPath = join(directory, "event.json");
    const outputPath = join(directory, "output");
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(outputPath, "");
    // Execute the actual workflow step, rather than a second copy of its policy.
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", scopeScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(outputPath, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each([
  ["ordinary PR", "pull_request", { pull_request: { base: { ref: "main" } } }, true],
  ["bottom layer", "pull_request", stacked("main", 1), true],
  ["new bottom after a merge", "pull_request", stacked("main", 2), true],
  ["upper layer", "pull_request", upper, false],
  ["main push", "push", {}, true],
  ["push with stack metadata", "push", upper, true],
  ["merge queue group", "merge_group", upper, true],
  ["missing PR", "pull_request", {}, true],
  ["missing repository", "pull_request", { pull_request: upper.pull_request }, true],
  ["empty repository", "pull_request", { ...upper, repository: { full_name: "" } }, true],
  [
    "missing stack base",
    "pull_request",
    { ...upper, pull_request: { ...upper.pull_request, stack: {} } },
    true,
  ],
  [
    "empty stack base",
    "pull_request",
    { ...upper, pull_request: { ...upper.pull_request, stack: { base: { ref: "" } } } },
    true,
  ],
  [
    "invalid stack base",
    "pull_request",
    { ...upper, pull_request: { ...upper.pull_request, stack: { base: { ref: 42 } } } },
    true,
  ],
  [
    "missing PR base",
    "pull_request",
    { ...upper, pull_request: { ...upper.pull_request, base: undefined } },
    true,
  ],
  ["empty PR base", "pull_request", stacked(""), true],
  [
    "missing head repository",
    "pull_request",
    { ...upper, pull_request: { ...upper.pull_request, head: { repo: null } } },
    true,
  ],
  [
    "different base repository",
    "pull_request",
    {
      ...upper,
      pull_request: {
        ...upper.pull_request,
        base: { ref: "feature/lower", repo: { full_name: "someone/scriptc" } },
      },
    },
    true,
  ],
])("CI selects the correct scope for %s", (_name, eventName, event, full) => {
  expect(runScope(eventName as string, event)).toBe(`full=${full}\n`);
});

test.each(["OWNER", "MEMBER", "COLLABORATOR"])(
  "only trusted same-repository %s stacks can defer full CI",
  (association) => {
    const event = {
      ...upper,
      pull_request: { ...upper.pull_request, author_association: association },
    };
    expect(runScope("pull_request", event)).toBe("full=false\n");
    expect(
      runScope("pull_request", {
        ...event,
        pull_request: {
          ...event.pull_request,
          head: { repo: { full_name: "someone/scriptc" } },
        },
      }),
    ).toBe("full=true\n");
  },
);

test.each(["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "unknown", undefined])(
  "outside contributors with association %s retain full CI",
  (association) => {
    expect(
      runScope("pull_request", {
        ...upper,
        pull_request: { ...upper.pull_request, author_association: association },
      }),
    ).toBe("full=true\n");
  },
);

test("scope selection treats branch metadata as data, without executing it", () => {
  expect(runScope("pull_request", stacked("feature/$(exit 1)\n'\"; exit 1"))).toBe("full=false\n");
  expect(scopeScript).not.toContain("${{");
  expect(scopeJob.permissions).toEqual({});
  expect(scopeJob.steps).toHaveLength(1);
  expect(scopeJob.steps![0]!.uses).toBeUndefined();
  expect(scopeScript).not.toContain("scripts/ci-stack-scope");
});

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
  // A skipped required job reports success, so aggregate even on cancellation.
  expect(workflow.jobs.test!.if).toBe("${{ always() }}");
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
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { encoding: "utf8" });
}

test("the required test check passes only after full validation", () => {
  expect(runGate("true").status).toBe(0);
  const deferred = runGate("false");
  expect(deferred.status).toBe(1);
  expect(deferred.stdout).toContain("Merge the stack from the bottom up");
  // Even a green top layer cannot make untested middle layers mergeable.
  expect(
    runGate("false", Object.fromEntries(heavyJobs.map((name) => [name, "success"]))).status,
  ).toBe(1);
});

test("full validation rejects any failed, cancelled or skipped expensive job", () => {
  for (const job of heavyJobs)
    for (const result of ["failure", "cancelled", "skipped"])
      expect(runGate("true", { [job]: result }).status, `${job}: ${result}`).toBe(1);
});

test("both scopes require successful planning and code quality", () => {
  for (const full of ["true", "false"])
    for (const job of ["validation_scope", "code_quality"])
      for (const result of ["failure", "cancelled", "skipped"])
        expect(runGate(full, { [job]: result }).status, `${full}: ${job}: ${result}`).toBe(1);
  for (const full of ["", "unknown"]) expect(runGate(full).status).toBe(1);
});
