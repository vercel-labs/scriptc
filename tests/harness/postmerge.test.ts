import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import {
  BLAME_ARTIFACT,
  MAX_PROBES,
  STATE_ARTIFACT,
  batches,
  bisect,
  formatReport,
  history,
  laneJobs,
  nativePackages,
  probeOrder,
  recipeFor,
  recipes,
  replaySteps,
  search,
  substitute,
  collectStates,
  trustedRuns,
  validState,
} from "../../scripts/postmerge.mjs";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type Job = {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  needs?: string | string[];
  permissions?: Record<string, string>;
  "runs-on"?: string;
  "timeout-minutes"?: number | string;
  steps?: Step[];
};
type Workflow = {
  name: string;
  on: Record<string, any>;
  concurrency?: { group: string; "cancel-in-progress": unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};
const workflow = (path: string) => load(read(path)) as Workflow;

const postmerge = workflow(".github/workflows/postmerge.yml");
const ci = workflow(".github/workflows/ci.yml");
const dryRun = workflow(".github/workflows/release-dry-run.yml");
const releaseBuild = workflow(".github/workflows/release-build.yml");
const platforms = JSON.parse(read(".github/release-platforms.json")) as Record<string, any>[];
// The workflows the post-merge lanes call, directly or through another call.
const callable = [
  ".github/workflows/ci.yml",
  ".github/workflows/release-dry-run.yml",
  ".github/workflows/release-build.yml",
  ".github/workflows/libnode-packs.yml",
];

test("the post-merge lanes run one at a time on main's green CI pushes and a schedule", () => {
  expect(postmerge.on.workflow_run).toEqual({
    workflows: [ci.name],
    types: ["completed"],
    branches: ["main"],
  });
  expect(postmerge.on.schedule).toHaveLength(1);
  expect(postmerge.on.workflow_dispatch.inputs.sha.default).toBe("");
  // One group without cancel-in-progress: a running run (and its bisection) finishes, and GitHub keeps only the
  // newest pending run.
  expect(postmerge.concurrency).toEqual({ group: "postmerge", "cancel-in-progress": false });
  expect(postmerge.jobs.pick!.if).toContain("github.event.workflow_run.conclusion == 'success'");
  expect(postmerge.jobs.pick!.if).toContain("github.event.workflow_run.event == 'push'");
});

test("the post-merge lanes test the picked commit with the macos lane and the release rehearsal", () => {
  const sha = "${{ needs.pick.outputs.sha }}";
  const macos = postmerge.jobs.macos!;
  expect(macos.uses).toBe("./.github/workflows/ci.yml");
  expect(macos.with).toEqual({ ref: sha, only_lane: "macos", macos_suite: "full" });
  const rehearsal = postmerge.jobs.rehearsal!;
  expect(rehearsal.uses).toBe("./.github/workflows/release-dry-run.yml");
  expect(rehearsal.with).toEqual({ ref: sha });
  for (const job of [macos, rehearsal])
    expect(job.if).toBe("${{ needs.pick.outputs.skip == 'false' }}");
  // The lane jobs' names are what the recipes and the state key on.
  expect(macos.name).toBe("macos");
  expect(rehearsal.name).toBe("rehearsal");
  expect(postmerge.jobs.plan!.needs).toEqual(["pick", "macos", "rehearsal"]);
});

test("the post-merge lanes only read: no job can open an issue or a pull request, or push", () => {
  expect(postmerge.permissions).toEqual({ contents: "read" });
  for (const [name, job] of Object.entries(postmerge.jobs)) {
    for (const [scope, level] of Object.entries(job.permissions ?? {}))
      // The one write: the CI call must grant what CI's roll-up job asks for, a step it skips here.
      if (!(name === "macos" && scope === "statuses"))
        expect(level, `${name} ${scope}`).toBe("read");
    if (job.uses === undefined) expect(job["timeout-minutes"], name).toBeDefined();
  }
  const text = read(".github/workflows/postmerge.yml");
  expect(text).not.toMatch(/gh (issue|pr) /);
  const script = read("scripts/postmerge.mjs");
  expect(script).not.toMatch(/"(issue|pr)", "create"|\/issues|\/pulls|--method|-X POST/);
  // The artifacts the script reads and writes are the ones the workflow uploads.
  expect(text).toContain(`name: ${STATE_ARTIFACT}`);
  expect(text).toContain(`name: ${BLAME_ARTIFACT}`);
});

test("every workflow the post-merge lanes call takes a ref and checks it out", () => {
  for (const path of callable) {
    const wf = workflow(path);
    expect(wf.on.workflow_call?.inputs?.ref, path).toEqual(
      expect.objectContaining({ type: "string", default: "" }),
    );
    for (const [name, job] of Object.entries(wf.jobs)) {
      // A nested call passes the ref on.
      if (job.uses?.startsWith("./.github/workflows/")) {
        expect(job.with?.ref, `${path} ${name}`).toBe("${{ inputs.ref }}");
        continue;
      }
      // A pull request's fast tier checks out the pull request; a post-merge call turns that tier off.
      if (job.if?.includes("needs.lanes.outputs.fast == 'true'")) continue;
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        // The lane selector's checkout runs on pull requests alone, at the pull request's head.
        // (and on a pull request's dispatched expensive tier, which a post-merge call never is).
        if (step.if?.startsWith("github.event_name == 'pull_request'")) continue;
        expect(step.with?.ref, `${path} ${name}`).toBe("${{ inputs.ref }}");
      }
    }
  }
});

test("a post-merge call of CI runs in its own concurrency group and skips the nightly-only jobs", () => {
  expect(ci.concurrency!.group).toMatch(
    /^ci-\$\{\{ inputs\.only_lane && format\('postmerge-\{0\}', github\.run_id\) \|\|/,
  );
  expect(dryRun.concurrency!.group).toContain(
    "inputs.ref && format('postmerge-{0}', github.run_id)",
  );
  // The rehearsal no longer has a nightly schedule of its own; the post-merge lanes run it.
  expect(dryRun.on.schedule).toBeUndefined();
  for (const [name, job] of Object.entries(ci.jobs))
    if (
      job.if?.includes("github.event_name == 'schedule'") &&
      !job.if.includes("needs.lanes.outputs")
    )
      expect(job.if, name).toContain("!inputs.only_lane");
});

// Job names as the jobs API reports them in a post-merge run: "<caller> / [<nested caller> / ]<job>".
function macosJobNames(id: string): string[] {
  const job = ci.jobs[id]!;
  const full = String(job.name).replace(
    /\$\{\{ \(github\.event_name != 'schedule' && inputs\.macos_suite != 'full'\) && '([^']*)' \|\| '([^']*)' \}\}/g,
    "$2",
  );
  const matrix = (job as any).strategy?.matrix ?? {};
  const flavors: string[] = matrix.flavor ?? [""];
  const shards: string[] = String(matrix.shard ?? "").includes("fromJSON")
    ? Array.from({ length: 10 }, (_, i) => String(i + 1))
    : (matrix.shard ?? [""]).map(String);
  const runtimes: string[] = matrix.runtime ?? [""];
  const names = [];
  for (const flavor of flavors)
    for (const shard of shards)
      for (const runtime of runtimes)
        names.push(
          `macos / ${full
            .replaceAll("${{ matrix.flavor }}", flavor)
            .replaceAll("${{ matrix.shard }}", shard)
            .replaceAll("${{ matrix.runtime }}", runtime)}`,
        );
  return names;
}

// Jobs no recipe probes on one runner, and why.
const unprobed: Record<string, string> = {
  // ci.yml's macos lane: built through the mobile-runtime-pack action.
  mobile_runtime_packs_ios: "composite action",
  // release-build.yml and release-dry-run.yml: they need other jobs' artifacts, or are not platform builds.
  plan: "reads a file",
  "cli-profile": "not run by the rehearsal",
  mobile: "composite action",
  assemble: "needs every platform's artifacts",
};

test("every job of the macos lane has a recipe that matches its names", () => {
  const macosLane = Object.entries(ci.jobs)
    .filter(([, job]) => job.if?.includes("needs.lanes.outputs.macos == 'true'"))
    .map(([id]) => id);
  expect(macosLane.length).toBeGreaterThan(4);
  for (const id of macosLane) {
    if (id in unprobed) continue;
    const recipe = recipes.find(
      (r: { job: string; workflow: string }) => r.job === id && r.workflow.endsWith("ci.yml"),
    );
    expect(recipe, id).toBeDefined();
    for (const name of macosJobNames(id))
      expect(recipeFor(name, platforms)?.recipe.id, name).toBe(recipe.id);
  }
});

test("the rehearsal's platform builds have recipes that match their names", () => {
  const prefix = `rehearsal / ${dryRun.jobs.build!.name} /`;
  expect(dryRun.jobs.build!.uses).toBe("./.github/workflows/release-build.yml");
  for (const id of Object.keys(releaseBuild.jobs)) {
    if (id in unprobed) continue;
    const recipe = recipes.find(
      (r: { job: string; workflow: string }) =>
        r.job === id && r.workflow.endsWith("release-build.yml"),
    );
    expect(recipe, id).toBeDefined();
    for (const platform of platforms) {
      const name = `${prefix} ${String(releaseBuild.jobs[id]!.name).replace("${{ matrix.platform }}", platform.platform)}`;
      const found = recipeFor(name, platforms);
      if (platform.platform === "windows-x64") expect(found, name).toBeUndefined();
      else {
        expect(found?.recipe.id, name).toBe(recipe.id);
        expect(found!.recipe.runner(found!.matrix), name).toBe(platform.runner);
      }
    }
  }
  for (const id of ["libnode", "assemble"]) expect(dryRun.jobs[id], id).toBeDefined();
});

test("every recipe replays the current workflow's steps without an expression it cannot fill in", () => {
  const files: Record<string, Workflow> = {
    ".github/workflows/ci.yml": ci,
    ".github/workflows/release-build.yml": releaseBuild,
  };
  for (const recipe of recipes) {
    const matrices = recipe.platform
      ? platforms.filter((p) => p.platform !== "windows-x64").map((p) => ({ ...p }))
      : [{ flavor: "san", shard: "3" }];
    for (const matrix of matrices) {
      const steps = replaySteps(files[recipe.workflow], recipe, matrix, "/tmp/probe");
      expect(steps.length, recipe.id).toBe(
        recipe.steps.filter((s: { when?: (m: unknown) => boolean }) => !s.when || s.when(matrix))
          .length +
          (recipe.packsFirst ? 2 : 0) -
          (recipe.packsFirst && !matrix.seed_helper ? 1 : 0) +
          (recipe.packsFirst && String(matrix.cli_target ?? "").endsWith("-musl") ? 1 : 0),
      );
      for (const step of steps) {
        expect(step.run, `${recipe.id} ${step.name}`).not.toContain("${{");
        for (const value of Object.values(step.env)) expect(value).not.toContain("${{");
      }
    }
  }
  // The tests_macos recipe runs the job's own test command, with the job's environment for the complete suite.
  const tests = recipes.find((r: { id: string }) => r.id === "tests_macos");
  expect(replaySteps(ci, tests, {}, "/tmp").map((s: { run: string }) => s.run)).toEqual([
    ci.jobs.tests_macos!.steps!.at(-1)!.run,
  ]);
  expect(tests.env({ flavor: "san", shard: "4" })).toEqual({
    SCRIPTC_TEST_WORKERS: "4",
    SCRIPTC_SAN: "1",
    SCRIPTC_TEST_SHARD: "4/10",
    SCRIPTC_CI_SUITE: "full",
  });
});

test("the probes' fixed commands are the ones the actions they stand for run", () => {
  const action = read(".github/actions/native-packages/action.yml");
  for (const target of ["darwin-arm64", "darwin-x64"])
    for (const line of nativePackages(target).run.split("\n")) expect(action, line).toContain(line);
  for (const line of nativePackages("x", { linux: true }).run.split("\n"))
    expect(action, line).toContain(line);
  expect(read(".github/actions/libnode/action.yml")).toContain(
    "node packages/libnode-common/fetch-dev-pack.mjs --out",
  );
});

test("substitute fills in matrix values and the runner's temporary directory, and nothing else", () => {
  expect(
    substitute(
      "pnpm --filter @scriptc/${{ matrix.helper }} -o ${{ runner.temp }}/x",
      { helper: "llvm-a" },
      "/t",
    ),
  ).toBe("pnpm --filter @scriptc/llvm-a -o /t/x");
  expect(substitute("${{ matrix.missing }}", {}, "/t")).toBe("");
  expect(() => substitute("${{ github.sha }}", {}, "/t")).toThrow(/cannot replay/);
});

test("batches end at each push to main", () => {
  expect(batches(["a", "b", "c", "d", "e"], ["b", "e", "zzz"])).toEqual([
    ["a", "b"],
    ["c", "d", "e"],
  ]);
  // Without the activity history every commit is a batch; the red commit always ends one.
  expect(batches(["a", "b"], [])).toEqual([["a"], ["b"]]);
  expect(batches(["a", "b", "c"], ["a"])).toEqual([["a"], ["b", "c"]]);
  expect(batches([], ["a"])).toEqual([]);
});

const probeWith = (firstBad: string, order: string[]) => {
  const probed: string[] = [];
  const probe = async (sha: string) => {
    probed.push(sha);
    return order.indexOf(sha) >= order.indexOf(firstBad) ? "fail" : "pass";
  };
  return { probe, probed };
};

test("search finds the first failing item in about log2(n) probes", async () => {
  const items = Array.from({ length: 16 }, (_, i) => `c${i}`);
  for (const bad of items) {
    const { probe, probed } = probeWith(bad, items);
    const { firstBad } = await search(items, probe);
    expect(items[firstBad!]).toBe(bad);
    expect(probed.length).toBeLessThanOrEqual(4);
    // The last item is known bad and is never probed again.
    expect(probed).not.toContain("c15");
  }
});

test("a bisection names the first bad commit inside the first bad batch", async () => {
  const list = [["a"], ["b", "c", "d"], ["e"], ["f", "g"]];
  const order = list.flat();
  const { probe, probed } = probeWith("c", order);
  const result = await bisect(list, probe);
  expect(result.outcome).toBe("found");
  expect(result.firstBad).toBe("c");
  expect(result.batch).toEqual(["b", "c", "d"]);
  // The red commit first, then the batches, then the commits of the bad batch.
  expect(probed[0]).toBe("g");
  expect(probed.length).toBeLessThanOrEqual(MAX_PROBES);
  expect(result.probes.map((p: { sha: string }) => p.sha)).toEqual(probed);
});

test("a bisection that does not reproduce the red result stops after one probe", async () => {
  const result = await bisect([["a"], ["b"]], async () => "pass");
  expect(result).toEqual({ outcome: "not-reproduced", probes: [{ sha: "b", result: "pass" }] });
});

test("a bisection out of probes reports the range it narrowed the change to", async () => {
  const list = Array.from({ length: 64 }, (_, i) => [`c${i}`]);
  const { probe } = probeWith("c40", list.flat());
  const result = await bisect(list, probe, { maxProbes: 3 });
  expect(result.outcome).toBe("narrowed");
  expect(result.probes).toHaveLength(3);
  expect(result.candidates).toContain("c40");
  expect(result.candidates.length).toBeLessThan(64);
  // Out of time behaves the same way.
  let clock = 0;
  const timed = await bisect(list, probeWith("c40", list.flat()).probe, {
    deadline: 2,
    now: () => clock++,
  });
  expect(timed.outcome).toBe("narrowed");
});

test("a job's history gives its last green commit and whether it was already red", () => {
  const states = [
    { sha: "s3", runId: 3, jobs: { "macos / x": "cancelled" } },
    { sha: "s2", runId: 2, jobs: { "macos / x": "failure", "macos / y": "success" } },
    { sha: "s1", runId: 1, jobs: { "macos / x": "success" } },
  ];
  expect(history(states, "macos / x")).toEqual({
    lastGreen: "s1",
    previous: { sha: "s2", conclusion: "failure", runId: 2 },
  });
  expect(history(states, "macos / y").lastGreen).toBe("s2");
  expect(history(states, "macos / z")).toEqual({ lastGreen: undefined, previous: undefined });
});

test("the state keeps the lane jobs of a run and the report names the first bad commit", () => {
  const jobs = laneJobs([
    { name: "Pick the newest green main commit", status: "completed", conclusion: "success" },
    { name: "macos / test (macOS, san, 4/10)", status: "completed", conclusion: "failure" },
    {
      name: "rehearsal / Build / Build native package (linux-x64)",
      status: "completed",
      conclusion: "success",
    },
    {
      name: "macos / build (macOS arm64 native packages)",
      status: "in_progress",
      conclusion: null,
    },
  ]);
  expect(jobs).toEqual({
    "macos / test (macOS, san, 4/10)": "failure",
    "rehearsal / Build / Build native package (linux-x64)": "success",
    "macos / build (macOS arm64 native packages)": "in_progress",
  });
  const task = {
    key: "1",
    job: "macos / test (macOS, san, 4/10)",
    good: "a".repeat(40),
    bad: "f".repeat(40),
    commits: 6,
    batches: 3,
  };
  const report = formatReport(
    {
      sha: "f".repeat(40),
      jobs,
      skipped: [{ job: "macos / other", reason: "no recipe probes this job on one runner" }],
      results: [
        {
          task,
          result: {
            outcome: "found",
            firstBad: "c".repeat(40),
            batch: ["b".repeat(40), "c".repeat(40)],
            probes: [{ sha: "f".repeat(40), result: "fail" }],
          },
        },
      ],
    },
    () => "Break darwin",
  );
  expect(report).toContain("**First bad commit: `cccccccccccc` Break darwin**");
  expect(report).toContain("- macos / test (macOS, san, 4/10)");
  expect(report).toContain("macos / other: no recipe probes this job on one runner");
});

test("a musl platform build lets pnpm install musl packages before the install, as the job does", () => {
  for (const id of ["release_packs", "release_cli"]) {
    const recipe = recipes.find((r: { id: string }) => r.id === id);
    const musl = platforms.find((p) => String(p.cli_target ?? "").endsWith("-musl"))!;
    const steps = replaySteps(releaseBuild, recipe, musl, "/tmp/probe");
    const order = probeOrder(recipe.prelude(musl), steps).map(
      (step: { name: string }) => step.name,
    );
    expect(order.indexOf("Let pnpm install musl platform packages"), id).toBe(0);
    expect(order.indexOf("Install"), id).toBe(1);
  }
  // In the job too, the step comes before pnpm install.
  const packs = releaseBuild.jobs.packs!.steps!;
  expect(packs.findIndex((s) => s.name === "Let pnpm install musl platform packages")).toBeLessThan(
    packs.findIndex((s) => s.run === "pnpm install --frozen-lockfile"),
  );
});

// The artifacts each workflow of a post-merge run uploads, and the patterns it downloads: one run holds them all.
function artifactNames(path: string) {
  const uploads: string[] = [];
  const downloads: string[] = [];
  for (const job of Object.values(workflow(path).jobs))
    for (const step of job.steps ?? []) {
      const name = step.with?.name;
      const pattern = step.with?.pattern;
      if (step.uses?.startsWith("actions/upload-artifact@") && typeof name === "string")
        uploads.push(name);
      if (step.uses?.startsWith("actions/download-artifact@"))
        downloads.push(String(pattern ?? name));
    }
  return { uploads, downloads };
}
const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/\$\{\{[^}]*\}\}/g, ".+").replace(/\*/g, ".*")}$`);

test("CI's artifacts in a post-merge run neither collide with the rehearsal's nor match what it downloads", () => {
  const ciNames = artifactNames(".github/workflows/ci.yml");
  const release = [
    ".github/workflows/release-dry-run.yml",
    ".github/workflows/release-build.yml",
    ".github/workflows/libnode-packs.yml",
  ].map(artifactNames);
  const releaseUploads = release.flatMap((r) => r.uploads);
  const releaseDownloads = release.flatMap((r) => r.downloads);
  expect(ciNames.uploads.length).toBeGreaterThan(3);
  for (const name of ciNames.uploads) {
    for (const other of releaseUploads)
      expect(
        glob(other).test(name.replace(/\$\{\{[^}]*\}\}/g, "x")) || glob(name).test(other),
        `${name} / ${other}`,
      ).toBe(false);
    for (const pattern of releaseDownloads)
      expect(
        glob(pattern).test(name.replace(/\$\{\{[^}]*\}\}/g, "x")),
        `${pattern} matches ${name}`,
      ).toBe(false);
  }
  // CI's own downloads find its uploads.
  for (const pattern of ciNames.downloads)
    expect(
      ciNames.uploads.some((name) => glob(pattern).test(name) || pattern === name),
      pattern,
    ).toBe(true);
});

const repository = "vercel-labs/scriptc";
const runOf = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  path: ".github/workflows/postmerge.yml",
  event: "workflow_run",
  head_branch: "main",
  head_sha: "b".repeat(40),
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  ...fields,
});

test("only this workflow's runs on main, started by its own triggers, count as post-merge results", () => {
  const runs = [
    runOf(1),
    runOf(2, { event: "schedule" }),
    runOf(3, { event: "workflow_dispatch" }),
    // A pull request that adds a trigger to postmerge.yml runs it as its own, and can upload a state.
    runOf(4, { event: "pull_request", head_branch: "feature" }),
    runOf(5, { event: "pull_request" }),
    // A dispatch on another branch, and a fork whose branch is also called main.
    runOf(6, { event: "workflow_dispatch", head_branch: "feature" }),
    runOf(7, { head_repository: { full_name: "someone/scriptc" } }),
    runOf(8, { path: ".github/workflows/other.yml" }),
    runOf(9, { event: "push" }),
  ];
  expect(trustedRuns(runs, repository).map((run: { id: number }) => run.id)).toEqual([1, 2, 3]);
  // The state loader reads trusted runs only.
  const script = read("scripts/postmerge.mjs");
  const loader = script.slice(
    script.indexOf("function* trustedRunPages"),
    script.indexOf("function pick"),
  );
  expect(loader).toContain("trustedRuns(");
  expect(loader).toContain("validState(");
});

test("a state counts only when it is well formed and names a commit its run could have tested", () => {
  const run = runOf(1);
  const ancestors = new Set(["a".repeat(40), "b".repeat(40)]);
  const isAncestor = (sha: string, of: string) => of === "b".repeat(40) && ancestors.has(sha);
  const good = { sha: "a".repeat(40), jobs: { "macos / test (macOS, san, 4/10)": "success" } };
  expect(validState(good, run, isAncestor)).toEqual({ ...good, runId: 1 });
  // A commit that is not the run's or an ancestor of it: a state cannot claim an untested commit was tested.
  expect(validState({ ...good, sha: "c".repeat(40) }, run, isAncestor)).toBeUndefined();
  for (const bad of [
    null,
    "text",
    { ...good, sha: "a".repeat(12) },
    { ...good, sha: "A".repeat(40) },
    { ...good, jobs: [] },
    { ...good, jobs: { "pick / x": "success" } },
    { ...good, jobs: { "macos / x": 1 } },
    { ...good, jobs: { "macos / x": "success; rm -rf /" } },
  ])
    expect(validState(bad, run, isAncestor), JSON.stringify(bad)).toBeUndefined();
});

test("runs that found nothing new do not push the last tested commit out of the lookup", () => {
  // Five scheduled runs that skipped (no state), then the run that tested the commit.
  const runs = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id }));
  const states: Record<number, { sha: string }> = { 6: { sha: "tested" }, 7: { sha: "older" } };
  const visited: number[] = [];
  const found = collectStates(runs, 1, (run: { id: number }) => {
    visited.push(run.id);
    return states[run.id];
  });
  expect(found).toEqual([{ sha: "tested" }]);
  // It stops once it has enough.
  expect(visited).toEqual([1, 2, 3, 4, 5, 6]);
  expect(collectStates(runs, 30, (run: { id: number }) => states[run.id])).toEqual([
    { sha: "tested" },
    { sha: "older" },
  ]);
  // pick asks for the newest state, however many runs skipped since.
  expect(read("scripts/postmerge.mjs")).toContain("loadStates(1)");
});

const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };
/** Every permission the jobs of a called workflow ask for, at its highest level, following nested calls. */
function askedFor(path: string): Record<string, string> {
  const wf = workflow(path);
  const asked: Record<string, string> = {};
  const add = (permissions: Record<string, string> | undefined) => {
    for (const [scope, level] of Object.entries(permissions ?? {}))
      if ((LEVEL[level] ?? 0) > (LEVEL[asked[scope] ?? "none"] ?? 0)) asked[scope] = level;
  };
  add(wf.permissions);
  for (const job of Object.values(wf.jobs)) {
    add(job.permissions);
    if (job.uses?.startsWith("./.github/workflows/")) add(askedFor(job.uses.slice(2)));
  }
  return asked;
}

test("each post-merge call grants every permission the called workflow's jobs ask for", () => {
  // GitHub rejects a call whose workflow asks for more than the calling job grants, even for jobs that do not run.
  for (const name of ["macos", "rehearsal"]) {
    const job = postmerge.jobs[name]!;
    const granted = job.permissions ?? {};
    for (const [scope, level] of Object.entries(askedFor(job.uses!.slice(2))))
      expect(LEVEL[granted[scope] ?? "none"], `${name}: ${scope}: ${level}`).toBeGreaterThanOrEqual(
        LEVEL[level]!,
      );
  }
  // The post-merge call reports no ci/full status: it tests another commit, and one lane of it. CI's required
  // check writes no status of its own, so the call has none to report.
  expect(ci.jobs.test!.steps!.some((step) => step.name === "Report ci/full")).toBe(false);
});
