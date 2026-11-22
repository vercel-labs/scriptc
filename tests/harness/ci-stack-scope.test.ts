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
  outputs?: Record<string, string>;
  steps?: { id?: string; name?: string; if?: string; run?: string; uses?: string }[];
};
const workflow = load(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };
const scopeJob = workflow.jobs.validation_scope!;
const gateStep = scopeJob.steps!.find((step) => step.id === "gate")!;
const scopeScript = scopeJob.steps!.find((step) => step.id === "scope")!.run!;
// Validation jobs that run only nightly and on manual runs, outside the
// required check (the shape overlay over the real-package suites).
const nightlyJobs = ["shape_overlay_native", "shape_overlay"];
const heavyJobs = Object.keys(workflow.jobs).filter(
  (name) => !["validation_scope", "code_quality", "test", ...nightlyJobs].includes(name),
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
  return runScopeOutputs(eventName, event).replace(/^tier=.*\n/m, "");
}

function runScopeOutputs(eventName: string, event: unknown, sha = "", gatePresent = "true") {
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
        GITHUB_SHA: sha,
        GATE_PRESENT: gatePresent,
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
  [
    "a PR into the default branch whose stack names another base",
    "pull_request",
    {
      ...stacked("main"),
      repository: { full_name: repository, default_branch: "main" },
      pull_request: { ...stacked("main").pull_request, stack: { base: { ref: "ni/base" } } },
    },
    true,
  ],
  [
    "upper layer with the default branch known",
    "pull_request",
    { ...upper, repository: { full_name: repository, default_branch: "main" } },
    false,
  ],
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
  expect(scopeJob.permissions).toEqual({ contents: "read" });
  expect(scopeJob.steps).toHaveLength(2);
  expect(gateStep.uses).toBeUndefined();
  // The probe reads both files the gate needs; only their presence on the default branch counts.
  expect(gateStep.run).toContain(".github/workflows/ci-review-gate.yml");
  expect(gateStep.run).toContain("scripts/ci-review-gate.mjs");
  expect(scopeScript).not.toContain("scripts/ci-stack-scope");
});

const full = "needs.validation_scope.outputs.full == 'true'";
const laneOf = (name: string) =>
  /needs\.lanes\.outputs\.(\w+) == 'true'/.exec(workflow.jobs[name]!.if ?? "")?.[1];

test("a pull request from this repository runs the fast tier until its reviews pass", () => {
  const ordinary = {
    repository: { full_name: repository, default_branch: "main" },
    pull_request: {
      author_association: "MEMBER",
      head: { repo: { full_name: repository } },
      base: { ref: "main", repo: { full_name: repository } },
      labels: [{ name: "enhancement" }],
    },
  };
  expect(runScopeOutputs("pull_request", ordinary)).toBe("full=true\ntier=fast\n");
  // The ci:full label overrides the gate.
  const labeled = {
    ...ordinary,
    pull_request: { ...ordinary.pull_request, labels: [{ name: "ci:full" }] },
  };
  expect(runScopeOutputs("pull_request", labeled)).toBe("full=true\ntier=full\n");
  // A fork's branch cannot be dispatched, so its pull request run runs every lane.
  const fork = {
    ...ordinary,
    pull_request: { ...ordinary.pull_request, head: { repo: { full_name: "someone/scriptc" } } },
  };
  expect(runScopeOutputs("pull_request", fork)).toBe("full=true\ntier=full\n");
  for (const eventName of ["push", "merge_group", "schedule"])
    expect(runScopeOutputs(eventName, { repository: ordinary.repository }), eventName).toBe(
      "full=true\ntier=full\n",
    );
  // The expensive tier ci-review-gate.yml dispatches runs on the commit the reviews passed on, and nothing once
  // the branch moved on.
  const gated = { repository: ordinary.repository, inputs: { pr: "12", sha: "abc", scope: "all" } };
  expect(runScopeOutputs("workflow_dispatch", gated, "abc")).toBe("full=true\ntier=full\n");
  expect(runScopeOutputs("workflow_dispatch", gated, "def")).toBe("full=false\ntier=superseded\n");
  const manual = { repository: ordinary.repository, inputs: { pr: "", sha: "", scope: "all" } };
  expect(runScopeOutputs("workflow_dispatch", manual, "def")).toBe("full=true\ntier=full\n");
});

test("a superseded expensive tier passes the required check without reporting ci/full", () => {
  const superseded = runGate("false", {}, undefined, "superseded");
  expect(superseded.status).toBe(0);
  expect(superseded.stdout).toContain("its new head runs its own CI");
  const report = workflow.jobs.test!.steps!.find((step) => step.name === "Report ci/full")!;
  expect(report.if).toContain("needs.validation_scope.outputs.tier != 'superseded'");
});

test("nightly validation jobs run only on schedule or manual runs, outside the required check", () => {
  for (const name of nightlyJobs) {
    expect(workflow.jobs[name], name).toBeDefined();
    expect(workflow.jobs[name]!.if, name).toBe(
      "${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' && inputs.pr == '' }}",
    );
    expect(workflow.jobs.test!.needs, name).not.toContain(name);
  }
});

test("every expensive CI job is gated and included in the required test check", () => {
  for (const name of heavyJobs) {
    const job = workflow.jobs[name]!;
    expect(job.needs, name).toContain("validation_scope");
    const lane = laneOf(name);
    // The lane selector itself and ungated jobs follow the stack scope alone; lane jobs also need their lane.
    if (lane === undefined) expect(job.if, name).toBe(`\${{ ${full} }}`);
    else {
      expect(job.if, name).toBe(`\${{ ${full} && needs.lanes.outputs.${lane} == 'true' }}`);
      expect(job.needs, name).toContain("lanes");
      expect(
        ["linux", "macos", "effects", "bootstrap", "profile", "islands", "macos_smoke", "fast"],
        name,
      ).toContain(lane);
    }
    expect(workflow.jobs.test!.needs, name).toContain(name);
  }
  expect(workflow.jobs.lanes!.if).toBe(`\${{ ${full} }}`);
  expect(workflow.jobs.code_quality!.if).toBeUndefined();
  expect(workflow.jobs.test!.needs).toContain("validation_scope");
  expect(workflow.jobs.test!.needs).toContain("code_quality");
  // A skipped required job reports success, so aggregate even on cancellation.
  expect(workflow.jobs.test!.if).toBe("${{ always() }}");
});

test("a lane the base revision's selector does not name leaves its job off", () => {
  // A pull request runs the base revision's selector, and one older than a
  // lane emits no output for it. Off keeps the required check passing on that
  // skip; an empty lane would fail it.
  // effect_shards is not a lane: it names the shards of the effects lane, and
  // every shard when the selector says nothing (ci-lanes.test.ts).
  const { effect_shards: effectShards, ...outputs } = workflow.jobs.lanes!.outputs!;
  expect(effectShards).toBeDefined();
  expect(Object.keys(outputs).sort()).toEqual([
    "bootstrap",
    "effects",
    "fast",
    "islands",
    "linux",
    "macos",
    "macos_smoke",
    "profile",
  ]);
  for (const [lane, output] of Object.entries(outputs))
    expect(output, lane).toBe(`\${{ steps.lanes.outputs.${lane} || 'false' }}`);
});

function runGate(
  full: string,
  results: Record<string, string> = {},
  lanes: Record<string, string> = {
    linux: "true",
    macos: "true",
    effects: "true",
    bootstrap: "true",
    macos_smoke: "true",
    fast: "true",
  },
  tier = "full",
) {
  const needs = Object.fromEntries(
    (workflow.jobs.test!.needs as string[]).map((name) => {
      const lane = laneOf(name);
      const skipped =
        (full === "false" && heavyJobs.includes(name)) ||
        (lane !== undefined && lanes[lane] === "false");
      return [
        name,
        {
          result: results[name] ?? (skipped ? "skipped" : "success"),
          outputs: { full, tier, ...lanes },
        },
      ];
    }),
  );
  const script = workflow.jobs
    .test!.steps!.find((step) => step.run)!
    .run!.replace(
      /\$\{\{ needs\.(\w+)\.(result|outputs\.\w+) \}\}/g,
      (_expression, name: string, field: string) =>
        field === "result"
          ? needs[name]!.result
          : (needs[name]!.outputs as Record<string, string>)[field.slice("outputs.".length)]!,
    );
  expect(script).not.toContain("${{");
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { encoding: "utf8" });
}

test("a pull request keeps full CI until the gate is on the default branch", () => {
  const ordinary = {
    repository: { full_name: repository, default_branch: "main" },
    pull_request: {
      author_association: "MEMBER",
      head: { repo: { full_name: repository } },
      base: { ref: "main", repo: { full_name: repository } },
      labels: [],
    },
  };
  expect(runScopeOutputs("pull_request", ordinary, "", "true")).toBe("full=true\ntier=fast\n");
  // The pull request that introduces the gate cannot be gated yet: its own run validates every lane, as before.
  expect(runScopeOutputs("pull_request", ordinary, "", "false")).toBe("full=true\ntier=full\n");
  // A probe that reports nothing counts as absent.
  expect(runScopeOutputs("pull_request", ordinary, "", "")).toBe("full=true\ntier=full\n");
  // The label still asks for full CI, and other events never take the fast tier.
  const labeled = {
    ...ordinary,
    pull_request: { ...ordinary.pull_request, labels: [{ name: "ci:full" }] },
  };
  expect(runScopeOutputs("pull_request", labeled, "", "false")).toBe("full=true\ntier=full\n");
  expect(runScopeOutputs("push", { repository: ordinary.repository }, "", "false")).toBe(
    "full=true\ntier=full\n",
  );
});

test("the required test check passes only after full validation", () => {
  expect(runGate("true").status).toBe(0);
  // A lane that is off may skip its jobs; a lane that is on may not.
  const linuxOnly = {
    linux: "true",
    macos: "false",
    effects: "false",
    bootstrap: "false",
    macos_smoke: "false",
  };
  expect(runGate("true", {}, linuxOnly).status).toBe(0);
  expect(runGate("true", { tests_macos: "skipped" }).status).toBe(1);
  // A push to main runs the macOS smoke job in place of the macOS lane.
  const mainPush = {
    linux: "true",
    macos: "false",
    effects: "true",
    bootstrap: "true",
    macos_smoke: "true",
  };
  expect(runGate("true", {}, mainPush).status).toBe(0);
  expect(runGate("true", { tests_macos_smoke: "skipped" }, mainPush).status).toBe(1);
  expect(runGate("true", { tests_macos_smoke: "failure" }, mainPush).status).toBe(1);
  expect(runGate("true", { effects: "failure" }, linuxOnly).status).toBe(1);
  expect(runGate("true", { lanes: "failure" }).status).toBe(1);
  const deferred = runGate("false");
  expect(deferred.status).toBe(1);
  expect(deferred.stdout).toContain("Merge the stack from the bottom up");
  // Even a green top layer cannot make untested middle layers mergeable.
  expect(
    runGate("false", Object.fromEntries(heavyJobs.map((name) => [name, "success"]))).status,
  ).toBe(1);
});

test("the fast tier passes the required check on its own jobs, with every lane off", () => {
  const fastTier = {
    linux: "false",
    macos: "false",
    effects: "false",
    bootstrap: "false",
    profile: "false",
    islands: "false",
    fast: "true",
  };
  expect(runGate("true", {}, fastTier, "fast").status).toBe(0);
  for (const result of ["failure", "cancelled", "skipped"])
    expect(runGate("true", { fast_tests: result }, fastTier, "fast").status, result).toBe(1);
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
