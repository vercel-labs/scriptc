import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { FAST_TEST_BUDGET_MS, fastTests } from "../../scripts/ci-fast-tests.mjs";
import {
  decide,
  forkStatus,
  reviewState,
  staleRuns,
  testJobToRerun,
  isExpensiveTierOf,
} from "../../scripts/ci-review-gate.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const repo = "vercel-labs/scriptc";
const sha = "a".repeat(40);

type Workflow = {
  on: Record<string, { types?: string[]; workflows?: string[] } | null>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      if?: string;
      permissions?: Record<string, string>;
      steps: { uses?: string; with?: Record<string, unknown>; run?: string }[];
    }
  >;
};
const gateWorkflow = load(
  readFileSync(join(repoRoot, ".github/workflows/ci-review-gate.yml"), "utf8"),
) as Workflow;

const review = (
  name: string,
  status: string,
  conclusion: string | null,
  started = "2026-11-21T10:00:00Z",
) => ({
  name,
  status,
  conclusion,
  started_at: started,
  app: { slug: "vercel" },
});
const passed = [
  review("Vercel Agent Review", "completed", "success"),
  review("Vercel Security Review", "completed", "neutral"),
];
const pr = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  state: "open",
  head: { sha, ref: "ctate/feature", repo: { full_name: repo } },
  base: { ref: "main" },
  labels: [],
  ...overrides,
});
const gate = (overrides: Record<string, unknown> = {}) =>
  decide({
    mode: "review",
    pr: pr(),
    repo,
    defaultBranch: "main",
    reviewedSha: sha,
    checkRuns: passed,
    runs: [],
    ...overrides,
  });

test("the expensive tier starts when both Vercel reviews passed on the pull request's head", () => {
  expect(gate()).toEqual({
    action: "dispatch",
    reason: `both reviews passed on ${sha}`,
    ref: "ctate/feature",
    inputs: { pr: "42", sha, macos_suite: "darwin", scope: "all" },
  });
  // One review still running, failed, or missing keeps it waiting.
  for (const checkRuns of [
    [passed[0]!, review("Vercel Security Review", "in_progress", null)],
    [passed[0]!, review("Vercel Security Review", "completed", "failure")],
    [passed[0]!, review("Vercel Security Review", "completed", "action_required")],
    [passed[0]!],
    // A check run of the same name from another app does not count.
    [passed[0]!, { ...passed[1]!, app: { slug: "github-actions" } }],
  ])
    expect(gate({ checkRuns }).action, JSON.stringify(checkRuns)).toBe("skip");
  // The latest run of a review counts: a re-run that failed undoes an earlier pass.
  expect(
    reviewState([
      ...passed,
      review("Vercel Agent Review", "completed", "failure", "2026-11-21T11:00:00Z"),
    ]).passed,
  ).toBe(false);
});

test("the gate skips stale reviews, forks, stack upper layers, closed and labeled pull requests", () => {
  expect(gate({ reviewedSha: "b".repeat(40) }).reason).toContain("the review ran on");
  expect(
    gate({ pr: pr({ head: { sha, ref: "x", repo: { full_name: "someone/scriptc" } } }) }).reason,
  ).toContain("fork");
  expect(gate({ pr: pr({ base: { ref: "ctate/lower" } }) }).reason).toContain(
    "targets ctate/lower",
  );
  expect(gate({ pr: pr({ state: "closed" }) }).action).toBe("skip");
  expect(gate({ pr: pr({ labels: [{ name: "ci:full" }] }) }).reason).toContain("ci:full");
});

test("the label and a manual run start the expensive tier whatever the reviews say", () => {
  for (const mode of ["label", "manual"]) {
    const decision = gate({ mode, checkRuns: [], reviewedSha: undefined });
    expect(decision.action, mode).toBe("dispatch");
    // Even on a pull request into another branch.
    expect(gate({ mode, checkRuns: [], pr: pr({ base: { ref: "ctate/lower" } }) }).action).toBe(
      "dispatch",
    );
  }
});

test("a running or green expensive tier of the same commit is not started again", () => {
  const run = (status: string, conclusion: string | null) => ({
    head_sha: sha,
    display_title: `Expensive tier of #42 at ${sha}`,
    status,
    conclusion,
    html_url: "https://example.test/run",
  });
  expect(gate({ runs: [run("in_progress", null)] }).action).toBe("skip");
  expect(gate({ runs: [run("queued", null)] }).action).toBe("skip");
  expect(gate({ runs: [run("completed", "success")] }).action).toBe("skip");
  // A failed or cancelled one may run again, for example after the label is added.
  expect(gate({ runs: [run("completed", "failure")] }).action).toBe("dispatch");
  expect(gate({ runs: [run("completed", "cancelled")] }).action).toBe("dispatch");
  // A dispatch for an older commit that raced a push ran, green and empty, on this head: it does not count.
  const raced = {
    ...run("completed", "success"),
    display_title: `Expensive tier of #42 at ${"c".repeat(40)}`,
  };
  expect(gate({ runs: [raced] }).action).toBe("dispatch");
  expect(gate({ runs: [{ ...raced, status: "in_progress", conclusion: null }] }).action).toBe(
    "dispatch",
  );
  // Another pull request's run on the same commit does not count either.
  expect(
    gate({
      runs: [{ ...run("completed", "success"), display_title: `Expensive tier of #7 at ${sha}` }],
    }).action,
  ).toBe("dispatch");
  expect(isExpensiveTierOf(run("queued", null), 42, sha)).toBe(true);
});

test("a fork's pull request run reports ci/full from its test job", () => {
  const run = {
    event: "pull_request",
    head_sha: sha,
    html_url: "https://example.test/run",
    head_repository: { full_name: "someone/scriptc" },
  };
  expect(
    forkStatus(run, [{ name: "test", status: "completed", conclusion: "success" }], repo),
  ).toEqual({
    sha,
    state: "success",
    description: "Every CI lane passed",
    target_url: run.html_url,
  });
  expect(
    forkStatus(run, [{ name: "test", status: "completed", conclusion: "failure" }], repo)!.state,
  ).toBe("failure");
  // This repository's runs report ci/full themselves; pushes report none.
  expect(forkStatus({ ...run, head_repository: { full_name: repo } }, [], repo)).toBeNull();
  expect(forkStatus({ ...run, event: "push" }, [], repo)).toBeNull();
});

test("the gate workflow triggers on the reviews, the label, fork runs and by hand, and runs no pull request code", () => {
  expect(gateWorkflow.on["check_run"]).toEqual({ types: ["completed"] });
  expect(gateWorkflow.on["pull_request"]).toEqual({ types: ["labeled", "synchronize"] });
  expect(gateWorkflow.jobs["gate"]!.if).toContain(
    "github.event.workflow_run.event == 'workflow_dispatch'",
  );
  expect(gateWorkflow.on["workflow_run"]).toEqual({ workflows: ["CI"], types: ["completed"] });
  expect(gateWorkflow.on["workflow_dispatch"]).toBeDefined();
  expect(gateWorkflow.permissions).toEqual({ contents: "read" });
  expect(gateWorkflow.concurrency["cancel-in-progress"]).toBe(false);
  const job = gateWorkflow.jobs["gate"]!;
  expect(job.if).toContain("github.event.check_run.app.slug == 'vercel'");
  expect(job.permissions).toEqual({
    contents: "read",
    actions: "write",
    checks: "read",
    "pull-requests": "read",
    statuses: "write",
  });
  // The default branch's gate script, never the pull request's, and no build or install.
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
  expect(checkout.with!["ref"]).toBe("${{ github.event.repository.default_branch }}");
  expect(checkout.with!["persist-credentials"]).toBe(false);
  expect(job.steps.filter((step) => step.run)).toHaveLength(1);
});

test("the fast tier runs the changed tests and the tests named after changed sources, within its budget", () => {
  const testFiles = [
    "packages/compiler/src/backend/emit-call.test.ts",
    "packages/compiler/test/emit-call.test.ts",
    "packages/runtime/src/scr_json.test.ts",
    "tests/harness/differential.test.ts",
    "tests/harness/ci-lanes.test.ts",
    "tests/harness/slow.test.ts",
  ];
  const costs = {
    "packages/compiler/src/backend/emit-call.test.ts": 1000,
    "packages/compiler/test/emit-call.test.ts": 2000,
    "packages/runtime/src/scr_json.test.ts": 500,
    "tests/harness/ci-lanes.test.ts": 300,
    "tests/harness/slow.test.ts": FAST_TEST_BUDGET_MS,
  };
  expect(
    fastTests(
      [
        "packages/compiler/src/backend/emit-call.ts",
        "packages/runtime/src/scr_json.c",
        "scripts/ci-lanes.mjs",
        "docs/readme.md",
      ],
      testFiles,
      costs,
    ),
  ).toEqual({
    selected: [
      "tests/harness/ci-lanes.test.ts",
      "packages/runtime/src/scr_json.test.ts",
      "packages/compiler/src/backend/emit-call.test.ts",
      "packages/compiler/test/emit-call.test.ts",
    ],
    deferred: [],
    total: 3800,
  });
  // The corpus suites and anything past the budget wait for the expensive tier.
  expect(
    fastTests(
      [
        "tests/harness/differential.test.ts",
        "tests/harness/slow.test.ts",
        "tests/harness/ci-lanes.test.ts",
      ],
      testFiles,
      costs,
    ),
  ).toEqual({
    selected: ["tests/harness/ci-lanes.test.ts"],
    deferred: ["tests/harness/differential.test.ts", "tests/harness/slow.test.ts"],
    total: 300,
  });
});

test("a push cancels the expensive tier still running on the pull request's older head", () => {
  const run = (id: number, head: string, status: string) => ({ id, head_sha: head, status });
  const newHead = "b".repeat(40);
  expect(
    staleRuns(
      [
        run(1, sha, "in_progress"),
        run(2, sha, "queued"),
        run(3, sha, "completed"),
        run(4, newHead, "queued"),
      ],
      newHead,
    ).map((stale) => stale.id),
  ).toEqual([1, 2]);
  expect(gateWorkflow.jobs["gate"]!.if).toContain("github.event.action == 'synchronize'");
});

test("a re-run of the fast tier does not turn a reported ci/full back to pending", () => {
  const ci = load(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as Workflow;
  const report = ci.jobs["test"]!.steps.find((step) => step.run?.includes("context=ci/full"))!.run!;
  const keep = report.indexOf('if [ "$reported" = success ] || [ "$reported" = failure ]; then');
  expect(report.indexOf('if [ "$state" = pending ]; then')).toBeGreaterThan(-1);
  expect(keep).toBeGreaterThan(report.indexOf('if [ "$state" = pending ]; then'));
  expect(keep).toBeLessThan(report.indexOf("gh api --method POST"));
});

test("the fast tier alone cannot turn the required test check green", () => {
  const ci = load(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as Workflow;
  const steps = ci.jobs["test"]!.steps as { name?: string; if?: string; run?: string }[];
  const require = steps.at(-1)!;
  expect(require.name).toBe("Require the expensive tier (ci/full)");
  expect(require.if).toBe("needs.validation_scope.outputs.tier == 'fast'");
  expect(require.run).toContain('if [ "$reported" != success ]; then');
  expect(require.run).toContain("exit 1");
  // It runs after the lanes passed and after ci/full is reported.
  expect(steps.findIndex((step) => step.name === "Report ci/full")).toBeLessThan(steps.length - 1);
});

test("a passing expensive tier re-runs the pull request run's test check on the same commit", () => {
  const dispatch = {
    event: "workflow_dispatch",
    conclusion: "success",
    head_sha: sha,
    display_title: `Expensive tier of #42 at ${sha}`,
  };
  const prRun = { head_sha: sha };
  const failedTest = { id: 7, name: "test", status: "completed", conclusion: "failure" };
  expect(testJobToRerun(dispatch, prRun, [failedTest])).toBe(failedTest);
  expect(testJobToRerun({ ...dispatch, conclusion: "failure" }, prRun, [failedTest])).toBeNull();
  expect(testJobToRerun(dispatch, { head_sha: "b".repeat(40) }, [failedTest])).toBeNull();
  expect(testJobToRerun(dispatch, undefined, [failedTest])).toBeNull();
  expect(testJobToRerun(dispatch, prRun, [{ ...failedTest, conclusion: "success" }])).toBeNull();
  expect(testJobToRerun(dispatch, prRun, [{ ...failedTest, status: "in_progress" }])).toBeNull();
  // A raced dispatch, titled with an older commit, and manual runs vouch for nothing.
  expect(
    testJobToRerun(
      { ...dispatch, display_title: `Expensive tier of #42 at ${"c".repeat(40)}` },
      prRun,
      [failedTest],
    ),
  ).toBeNull();
  expect(testJobToRerun({ ...dispatch, display_title: "CI" }, prRun, [failedTest])).toBeNull();
});

test("expensive-tier runs carry their pull request and commit in their title, and the gate skips until it is on main", () => {
  const ci = load(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as {
    "run-name": string;
  };
  expect(ci["run-name"]).toBe(
    "${{ inputs.pr != '' && format('Expensive tier of #{0} at {1}', inputs.pr, inputs.sha) || '' }}",
  );
  const run = gateWorkflow.jobs["gate"]!.steps.at(-1)!.run!;
  expect(run).toContain("if [ ! -f scripts/ci-review-gate.mjs ]; then");
  expect(run.trim().endsWith("node scripts/ci-review-gate.mjs")).toBe(true);
});
