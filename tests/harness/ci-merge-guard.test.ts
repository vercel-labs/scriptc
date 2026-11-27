/* The merge guard (scripts/ci/merge-guard.mjs, .github/workflows/merge-guard.yml and
 * merge-guard-sweep.yml) builds the tree the merge queue would build — the pull request's head merged into the
 * current origin/canary — and runs the quick checks two pull requests broke together today. These tests pin the
 * selection, the workflow wiring and the conflict and status reporting, so a change to any of them fails here
 * rather than silently narrowing what the guard checks. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import {
  GUARD_CHECK,
  MERGE_GUARD_SUITES,
  PROJECT_CONFIG_FILE,
  PROJECT_CONFIG_SNAPSHOTS,
  SWEEP_LIMIT,
  guardChecks,
  guardSuiteFiles,
  projectConfigFilter,
  selectSweep,
} from "../../scripts/ci/merge-guard.mjs";

const root = join(import.meta.dirname, "../..");
const text = (path: string) => readFileSync(join(root, path), "utf8");

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};
type Job = {
  name?: string;
  if?: string;
  needs?: string;
  outputs?: Record<string, string>;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  steps: Step[];
};
type ParsedAction = {
  inputs?: Record<string, { default?: string }>;
  runs: { steps: Step[] };
};
type ParsedWorkflow = {
  on: Record<string, any>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const workflow = load(text(".github/workflows/merge-guard.yml")) as ParsedWorkflow;
const sweepWorkflow = load(text(".github/workflows/merge-guard-sweep.yml")) as ParsedWorkflow;
const action = load(text(".github/actions/merge-guard/action.yml")) as ParsedAction;
const nativePackages = load(text(".github/actions/native-packages/action.yml")) as ParsedAction;

const stepNamed = (steps: Step[], name: string): Step => {
  const step = steps.find((candidate) => candidate.name === name);
  expect(step, name).toBeDefined();
  return step!;
};

const pull = (
  number: number,
  overrides: Partial<{ draft: boolean; mergeable_state: string; updated_at: string }> = {},
) => ({
  number,
  head: { sha: `head-${number}` },
  draft: false,
  mergeable_state: "clean",
  updated_at: new Date(Date.UTC(2026, 10, 27, 0, 0, number)).toISOString(),
  ...overrides,
});

test("the merge guard's suites exist and are test files", () => {
  expect(MERGE_GUARD_SUITES.length).toBeGreaterThan(0);
  for (const file of guardSuiteFiles()) {
    expect(file, `${file} is a test file`).toMatch(/\.test\.ts$/);
    expect(existsSync(join(root, file)), `${file} exists`).toBe(true);
  }
});

test("the guard runs the checks that broke the queue", () => {
  expect(guardChecks().map(({ command, args }) => [command, ...args])).toEqual([
    ["pnpm", "format:check"],
    ["pnpm", "lint"],
    ["pnpm", "test:ts7", "--baselines-only"],
    ["pnpm", "test", ...MERGE_GUARD_SUITES],
    ["pnpm", "test", PROJECT_CONFIG_FILE, "-t", projectConfigFilter()],
  ]);
});

test("the project-config filter selects exactly the node-types snapshot tests", () => {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env["VITEST"];
  delete env["VITEST_MODE"];
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "list", PROJECT_CONFIG_FILE, "-t", projectConfigFilter()],
    { cwd: root, encoding: "utf8", env },
  );
  expect(result.status, result.stderr).toBe(0);
  const prefix = `${PROJECT_CONFIG_FILE} > `;
  const listed = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  expect(listed.sort()).toEqual([...PROJECT_CONFIG_SNAPSHOTS].sort());
});

test("a sweep takes only ready pull requests, newest first, once per canary tip", () => {
  const { chosen, skipped } = selectSweep({
    pulls: [
      pull(1, { draft: true }),
      pull(2, { mergeable_state: "unstable" }),
      pull(3, { mergeable_state: "dirty" }),
      pull(4),
      pull(5),
      pull(6),
    ],
    guarded: new Set(["head-4"]),
  });
  expect(chosen).toEqual([
    { number: 6, head: "head-6" },
    { number: 5, head: "head-5" },
  ]);
  expect(skipped).toEqual(
    expect.arrayContaining([
      { number: 1, reason: "draft" },
      { number: 2, reason: "not ready to merge (unstable)" },
      { number: 3, reason: "not ready to merge (dirty)" },
      { number: 4, reason: "already guarded against this canary" },
    ]),
  );
});

test("a sweep stops at its limit and says which pull requests it left", () => {
  const pulls = Array.from({ length: SWEEP_LIMIT + 2 }, (_, index) => pull(index + 1));
  const { chosen, skipped } = selectSweep({ pulls });
  expect(chosen).toHaveLength(SWEEP_LIMIT);
  // The newest updates go first, so the two oldest are the ones left.
  expect(skipped.map((entry) => entry.number).sort()).toEqual([1, 2]);
  for (const entry of skipped)
    expect(entry.reason).toBe(`over the ${SWEEP_LIMIT}-pull-request sweep limit`);
});

test("the pull request guard merges the head into the current canary", () => {
  expect(workflow.on["pull_request"].branches).toEqual(["canary"]);
  expect(workflow.on["merge_group"]).toBeDefined();
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const [name, job] of Object.entries(workflow.jobs))
    expect(job["timeout-minutes"], `${name} has a timeout`).toBeGreaterThan(0);

  const job = workflow.jobs["guard_pr"]!;
  expect(job.if).toContain("pull_request");
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout"));
  expect(checkout?.with).toMatchObject({ ref: "canary", "fetch-depth": 0 });
  const guard = job.steps.find((step) => step.uses === "./.github/actions/merge-guard");
  expect(guard?.with?.["pr"]).toContain("pull_request.number");
  expect(guard?.with?.["head"]).toContain("pull_request.head.sha");
  // The result lands on the pull request's head as one context branch protection can require.
  expect(job.permissions).toMatchObject({ statuses: "write" });

  const queue = workflow.jobs["queue_entry"]!;
  expect(queue.if).toContain("merge_group");
  const queueGuard = queue.steps.find((step) => step.uses === "./.github/actions/merge-guard");
  expect(queueGuard?.with).toBeUndefined();
});

test("the sweep re-checks ready pull requests when canary moves", () => {
  expect(sweepWorkflow.on["push"].branches).toEqual(["canary"]);
  expect(sweepWorkflow.on["schedule"]).toHaveLength(1);
  expect(sweepWorkflow.on["workflow_dispatch"]).toBeDefined();
  expect(sweepWorkflow.permissions).toEqual({ contents: "read" });
  for (const [name, job] of Object.entries(sweepWorkflow.jobs))
    expect(job["timeout-minutes"], `${name} has a timeout`).toBeGreaterThan(0);

  const plan = sweepWorkflow.jobs["plan"]!;
  expect(plan.outputs?.["pulls"]).toContain("steps.plan.outputs.pulls");
  expect(plan.permissions).toMatchObject({ "pull-requests": "read", statuses: "read" });
  expect(plan.steps.map((step) => step.run)).toContain(
    "node scripts/ci/merge-guard.mjs --plan --github-output",
  );

  const sweep = sweepWorkflow.jobs["sweep"]!;
  expect(sweep.needs).toBe("plan");
  expect(sweep.if).toContain("matrix.pull.number");
  expect(sweep.permissions).toMatchObject({ statuses: "write" });
  const guard = sweep.steps.find((step) => step.uses === "./.github/actions/merge-guard");
  expect(guard?.with?.["pr"]).toContain("matrix.pull.number");
  expect(guard?.with?.["head"]).toContain("matrix.pull.head");
});

test("the action fails a conflict by name and reports one context on the head", () => {
  const merge = stepNamed(action.runs.steps, "Merge the head into origin/canary");
  expect(merge.if).toContain("inputs.pr");
  expect(merge.run).toContain("refs/pull/${PR}/head:refs/remotes/origin/pr-${PR}");
  expect(merge.run).toContain("merge --no-ff --no-commit");
  expect(merge.run).toContain("::error title=Merge conflict::");
  expect(merge.run).toContain("Conflicted files:");
  expect(merge.run).toContain("canary=$canary");
  expect(merge.run).toContain('echo "canary=$canary" >> "$GITHUB_OUTPUT"');

  const report = stepNamed(action.runs.steps, "Report the guard on the head");
  expect(report.if).toContain("inputs.head");
  expect(report.run).toContain(GUARD_CHECK);
  expect(report.run).toContain("repos/${GITHUB_REPOSITORY}/statuses/${HEAD}");
  expect(report.run).toContain('state="$state"');
  // A guard that outlived its canary tip leaves the report to the sweep instead of overwriting a fresher one.
  expect(report.run).toContain("commits/canary");
  expect(report.run).toContain('"$current" != "$CANARY"');
  // The description names the canary the guard actually merged with, not whatever HEAD is by then.
  expect(report.env?.CANARY).toContain("steps.merge.outputs.canary");
  // A fork's read-only token cannot post the status; its job still reports as a check.
  expect(report["continue-on-error"]).toBe(true);
});

test("the guard restores the helper native-packages built, without the runtime pack", () => {
  const restore = stepNamed(action.runs.steps, "Restore the LLVM helper");
  expect(restore.with?.path).toBe("packages/llvm-linux-x64-gnu/bin");
  const nativeHelper = nativePackages.runs.steps.find((step) => step.id === "helper");
  // The same key means a lane that already built the helper for these sources hands it over, and this action
  // does not invalidate the native-packages caches.
  const hashInputs = (key: string | undefined) => key?.slice(key.indexOf("hashFiles("));
  expect(hashInputs(restore.with?.key)).toBe(hashInputs(nativeHelper?.with?.key));
  const build = stepNamed(action.runs.steps, "Build the LLVM helper");
  expect(build.if).toContain("cache-hit != 'true'");
  expect(build.run).toBe('pnpm --filter "@scriptc/llvm-$SCRIPTC_PACKAGE_TARGET" build:native');
  const runs = action.runs.steps.map((step) => step.run ?? "").join("\n");
  expect(runs).not.toContain("@scriptc/runtime-");
  expect(action.runs.steps.map((step) => step.run)).toContain("node scripts/ci/merge-guard.mjs");
});
