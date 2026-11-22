#!/usr/bin/env node
// The post-merge lanes (.github/workflows/postmerge.yml): the complete macOS suite and the release rehearsal on the
// newest green main commit, and, when one of their jobs turns red, a bisection over the main batches since that
// job's last green commit that names the first bad commit.
//
// usage:
//   postmerge.mjs pick                  the commit to test (GITHUB_OUTPUT: sha, skip)
//   postmerge.mjs plan --sha <sha>      record this run's job results, and plan a bisection for each job that
//                                       turned red (GITHUB_OUTPUT: tasks)
//   postmerge.mjs bisect --task <json>  run one planned bisection on this runner
//   postmerge.mjs report --dir <dir>    the job summary and the blame report from the bisections' results
//
// pick, plan and report call `gh` with GH_TOKEN (actions: read, contents: read) and read GITHUB_REPOSITORY and
// GITHUB_RUN_ID. Each run uploads its job results as the postmerge-state artifact; later runs read them to find a
// job's last green commit and to skip a commit that was already tested.
//
// A bisection probes one commit by checking it out, building it, and running the red job's own commands from that
// commit's workflow file (the recipes below name the steps), with the job's matrix values. It first probes the red
// commit itself: a job that passes there is reported as not reproduced, and nothing is bisected. It then searches
// the batches (each push to main: one merge queue merge, or one direct push) for the first bad batch, and inside a
// batch of several commits, the first bad commit. It stops after maxProbes probes or when its time runs out, and
// then reports the range it narrowed the change to.
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STATE_ARTIFACT = "postmerge-state";
export const BLAME_ARTIFACT = "postmerge-blame";
/** Earlier runs whose results are read for a job's last green commit. */
export const STATE_HISTORY = 30;
/** At most this many bisections per run, one per recipe; they run in parallel. */
export const MAX_BISECTIONS = 3;
/** At most this many probes per bisection, the red commit's included: 2^5 batches. */
export const MAX_PROBES = 6;

// ---------------------------------------------------------------------------------------------------------------
// Recipes: how to probe one red job on one runner.

const ci = ".github/workflows/ci.yml";
const releaseBuild = ".github/workflows/release-build.yml";
const platforms = ".github/release-platforms.json";

/** The commands .github/actions/native-packages runs when nothing is cached, for one target. */
export function nativePackages(target, { linux = false } = {}) {
  const runtime = linux
    ? 'CC=zig AR=zig pnpm --filter "@scriptc/runtime-$SCRIPTC_PACKAGE_TARGET" build:native'
    : 'pnpm --filter "@scriptc/runtime-$SCRIPTC_PACKAGE_TARGET" build:native';
  return {
    name: `Build native packages (${target})`,
    env: { SCRIPTC_PACKAGE_TARGET: target },
    run: [
      'pnpm --filter "@scriptc/llvm-$SCRIPTC_PACKAGE_TARGET" build:native',
      runtime,
      'node "packages/runtime-$SCRIPTC_PACKAGE_TARGET/scripts/verify.mjs"',
    ].join("\n"),
  };
}

const install = { name: "Install", run: "pnpm install --frozen-lockfile" };
const build = { name: "Build", run: "pnpm build" };
// .github/actions/libnode without a cached libnode-packs build: the pinned development pack.
const libnode = {
  name: "libnode development pack",
  run: 'node packages/libnode-common/fetch-dev-pack.mjs --out "$SCRIPTC_LIBNODE"',
};

/**
 * Each recipe matches the names the jobs API reports for a job of this workflow ("<caller job> / <job>", one level
 * per reusable workflow call), and probes it with fixed commands (prelude) and then the job's own steps, replayed
 * from the probed commit's workflow file. A replayed step is named by a prefix of its name; `when` decides from the
 * matrix whether the job runs it. `setup` is the toolchain the bisect job installs once, before the first probe.
 */
export const recipes = [
  {
    id: "native_macos",
    pattern: /^macos \/ build \(macOS arm64 native packages\)$/,
    runner: () => "macos-15",
    setup: "macos",
    timeoutMinutes: 40,
    prelude: () => [install, nativePackages("darwin-arm64")],
    workflow: ci,
    job: "native_macos",
    steps: [],
    env: () => ({}),
  },
  {
    id: "tests_macos",
    pattern: /^macos \/ test \(macOS, (?<flavor>plain|san), (?<shard>\d+)\/10\)$/,
    runner: () => "macos-15",
    setup: "macos",
    timeoutMinutes: 120,
    prelude: () => [install, nativePackages("darwin-arm64"), build, libnode],
    workflow: ci,
    job: "tests_macos",
    steps: [{ step: "Tests (" }],
    env: ({ flavor, shard }) => ({
      SCRIPTC_TEST_WORKERS: "4",
      SCRIPTC_SAN: flavor === "san" ? "1" : "",
      SCRIPTC_TEST_SHARD: `${shard}/10`,
      SCRIPTC_CI_SUITE: "full",
    }),
  },
  {
    id: "llvm_artifacts_macos_arm64",
    pattern: /^macos \/ test \(macOS arm64 LLVM artifacts, no clang, (?<shard>\d+)\/10\)$/,
    runner: () => "macos-15",
    setup: "macos",
    timeoutMinutes: 70,
    prelude: () => [install, nativePackages("darwin-arm64"), build, libnode],
    workflow: ci,
    job: "llvm_artifacts_macos_arm64",
    steps: [{ step: "LLVM release/dev differential" }],
    env: ({ shard }) => ({ SCRIPTC_TEST_SHARD: `${shard}/10` }),
  },
  {
    id: "llvm_artifacts_macos_arm64_contracts",
    pattern: /^macos \/ test \(macOS arm64 LLVM artifacts, no clang, contracts\)$/,
    runner: () => "macos-15",
    setup: "macos",
    timeoutMinutes: 70,
    prelude: () => [install, nativePackages("darwin-arm64"), build, libnode],
    workflow: ci,
    job: "llvm_artifacts_macos_arm64_contracts",
    steps: [
      { step: "Node island harness" },
      { step: "No-clang assembly/object contract" },
      { step: "Helper diagnostics and object/link parity" },
      { step: "Packaged helper contract" },
      { step: "Packed npm installation smoke" },
    ],
    env: () => ({}),
  },
  {
    id: "llvm_artifacts_macos_x64",
    pattern: /^macos \/ test \(macOS x64 LLVM artifacts, no clang\)$/,
    runner: () => "macos-15-intel",
    setup: "macos",
    timeoutMinutes: 45,
    prelude: () => [install, nativePackages("darwin-x64"), build, libnode],
    workflow: ci,
    job: "llvm_artifacts_macos_x64",
    steps: [
      { step: "Node islands (Intel)" },
      { step: "Intel Mach-O no-clang object contract" },
      { step: "Intel helper/runtime-pack executable smoke" },
    ],
    env: () => ({}),
  },
  // The rehearsal's platform builds (release-build.yml's packs and cli jobs). Windows is not probed: the probe runs
  // its steps with bash.
  {
    id: "release_packs",
    pattern: /^rehearsal \/ Build \/ Build helper and runtime pack \((?<platform>[^)]+)\)$/,
    platform: true,
    runner: (matrix) => matrix.runner,
    setup: "release-toolchain",
    timeoutMinutes: 90,
    prelude: () => [],
    workflow: releaseBuild,
    job: "packs",
    steps: [
      {
        step: "Let pnpm install musl platform packages",
        when: (m) => (m.cli_target ?? "").endsWith("-musl"),
      },
      { step: "Build native packages (POSIX)" },
      { step: "Build host helper for cross-libc bootstrap", when: (m) => Boolean(m.seed_helper) },
    ],
    env: () => ({}),
  },
  {
    id: "release_cli",
    pattern: /^rehearsal \/ Build \/ Build native package \((?<platform>[^)]+)\)$/,
    platform: true,
    runner: (matrix) => matrix.runner,
    setup: "release-toolchain",
    timeoutMinutes: 150,
    prelude: () => [],
    workflow: releaseBuild,
    job: "cli",
    // The packs job's build first: the cli job starts from its artifact.
    packsFirst: true,
    steps: [{ step: "Build native CLI distribution", when: (m) => Boolean(m.cli) }],
    env: () => ({}),
  },
];

/** The recipe and matrix values for a job name the jobs API reports, or undefined when no recipe probes it. */
export function recipeFor(name, platformList = []) {
  for (const recipe of recipes) {
    const match = recipe.pattern.exec(name);
    if (!match) continue;
    let matrix = { ...match.groups };
    if (recipe.platform) {
      const platform = platformList.find((p) => p.platform === matrix.platform);
      if (!platform || platform.platform === "windows-x64") return undefined;
      matrix = { ...platform };
    }
    return { recipe, matrix };
  }
  return undefined;
}

/** `${{ matrix.<key> }}` and `${{ runner.temp }}` filled in; any other expression cannot be replayed. */
export function substitute(text, matrix, runnerTemp) {
  return text.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (whole, expression) => {
    const key = /^matrix\.([\w-]+)$/.exec(expression)?.[1];
    if (key !== undefined) return String(matrix[key] ?? "");
    if (expression === "runner.temp") return runnerTemp;
    throw new Error(`cannot replay ${whole}`);
  });
}

/** The steps a recipe's job runs, read from a parsed workflow, with the matrix filled in. */
export function replaySteps(workflow, recipe, matrix, runnerTemp) {
  const jobOf = (id) => {
    const job = workflow.jobs?.[id];
    if (!job) throw new Error(`the workflow has no job ${id}`);
    return job;
  };
  const pick = (job, refs) =>
    refs
      .filter((ref) => !ref.when || ref.when(matrix))
      .map((ref) => {
        const step = job.steps.find(
          (s) => typeof s.name === "string" && s.name.startsWith(ref.step),
        );
        if (!step) throw new Error(`no step named ${ref.step}`);
        if (typeof step.run !== "string") throw new Error(`step ${ref.step} has no run`);
        const env = Object.fromEntries(
          Object.entries(step.env ?? {}).map(([k, v]) => [
            k,
            substitute(String(v), matrix, runnerTemp),
          ]),
        );
        return { name: ref.step, env, run: substitute(step.run, matrix, runnerTemp) };
      });
  const steps = [];
  if (recipe.packsFirst) {
    const packs = recipes.find((r) => r.id === "release_packs");
    steps.push(...pick(jobOf(packs.job), packs.steps));
  }
  steps.push(...pick(jobOf(recipe.job), recipe.steps));
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------
// Results, batches and the search.

/** The lane jobs of a run (the jobs of the macos and rehearsal calls) and their conclusions. */
export function laneJobs(jobs) {
  const out = {};
  for (const job of jobs) {
    if (!/^(macos|rehearsal) \//.test(job.name)) continue;
    out[job.name] = job.status === "completed" ? job.conclusion : job.status;
  }
  return out;
}

const red = (conclusion) => conclusion === "failure" || conclusion === "timed_out";

/**
 * What an earlier run says about a job, from the states of earlier runs (newest first): its last green commit, and
 * whether its most recent result was red (then it was red before this run, and is not bisected again).
 */
export function history(states, name) {
  let previous;
  for (const state of states) {
    const conclusion = state.jobs?.[name];
    if (conclusion === undefined || conclusion === "skipped" || conclusion === "cancelled")
      continue;
    previous ??= { sha: state.sha, conclusion, runId: state.runId };
    if (conclusion === "success") return { lastGreen: state.sha, previous };
  }
  return { lastGreen: undefined, previous };
}

/**
 * The batches from `good` (exclusive) to `bad` (inclusive): `commits` are main's first-parent commits in that range,
 * oldest first; `pushes` are the commits main's pushes left it at (the activity API's `after`). Each batch ends at a
 * push; commits that no push names (an incomplete activity history) join the batch of the next push. With no pushes
 * known, every commit is its own batch.
 */
export function batches(commits, pushes) {
  if (commits.length === 0) return [];
  const tips = new Set(pushes);
  const out = [];
  let current = [];
  for (const [index, sha] of commits.entries()) {
    current.push(sha);
    if (tips.size === 0 || tips.has(sha) || index === commits.length - 1) {
      out.push(current);
      current = [];
    }
  }
  return out;
}

/**
 * The first item for which probe reports "fail", given that the item before items[0] passes and that the last item
 * fails (it is not probed again). Binary search; `probe` returns "pass" or "fail". Stops early when budget() is
 * false and then returns the narrowed range: firstBad undefined, lastGood and firstKnownBad the ends.
 */
export async function search(items, probe, budget = () => true) {
  let lo = -1; // index of the last item known to pass (-1: the item before the list)
  let hi = items.length - 1; // index of the first item known to fail
  while (hi - lo > 1) {
    if (!budget()) return { firstBad: undefined, lastGood: lo, firstKnownBad: hi };
    const mid = Math.floor((lo + hi) / 2);
    if ((await probe(items[mid])) === "pass") lo = mid;
    else hi = mid;
  }
  return { firstBad: hi, lastGood: lo, firstKnownBad: hi };
}

/**
 * The whole bisection: the red commit (the last batch's tip) is probed first, then the batches, then the commits of
 * the first bad batch. Returns a result the report formats.
 */
export async function bisect(
  batchList,
  probe,
  { maxProbes = MAX_PROBES, deadline = Infinity, now = Date.now } = {},
) {
  const probes = [];
  const run = async (sha) => {
    const result = await probe(sha);
    probes.push({ sha, result });
    return result;
  };
  const budget = () => probes.length < maxProbes && now() < deadline;
  if (batchList.length === 0) return { outcome: "no-candidates", probes };
  const tips = batchList.map((batch) => batch.at(-1));
  if ((await run(tips.at(-1))) === "pass") return { outcome: "not-reproduced", probes };
  const level1 = await search(tips, run, budget);
  if (level1.firstBad === undefined) {
    return {
      outcome: "narrowed",
      probes,
      lastGood: level1.lastGood >= 0 ? tips[level1.lastGood] : undefined,
      candidates: batchList.slice(level1.lastGood + 1, level1.firstKnownBad + 1).flat(),
    };
  }
  const batch = batchList[level1.firstBad];
  const level2 = await search(batch, run, budget);
  if (level2.firstBad === undefined) {
    return {
      outcome: "narrowed",
      probes,
      batch,
      candidates: batch.slice(level2.lastGood + 1, level2.firstKnownBad + 1),
    };
  }
  return { outcome: "found", probes, batch, firstBad: batch[level2.firstBad] };
}

/** One bisection's result as Markdown, with the commits' subjects (`describe(sha)`). */
export function formatResult(task, result, describe = (sha) => sha) {
  const short = (sha) => sha.slice(0, 12);
  const line = (sha) => `\`${short(sha)}\` ${describe(sha)}`;
  const out = [`### ${task.job}`, ""];
  out.push(
    `Red at \`${short(task.bad)}\`, last green at \`${short(task.good)}\`; ${task.commits} commits in ${task.batches} batches.`,
    "",
  );
  switch (result.outcome) {
    case "found":
      out.push(`**First bad commit: ${line(result.firstBad)}**`);
      if (result.batch.length > 1)
        out.push(
          "",
          `It landed in a batch of ${result.batch.length} commits, ending at \`${short(result.batch.at(-1))}\`.`,
        );
      break;
    case "narrowed":
      out.push(
        `Not narrowed to one commit within ${result.probes.length} probes. The change is one of:`,
        "",
      );
      for (const sha of result.candidates) out.push(`- ${line(sha)}`);
      break;
    case "not-reproduced":
      out.push(
        `The job passed when probed again at \`${short(task.bad)}\`: a flaky failure, or one that needs the full job. Not bisected.`,
      );
      break;
    case "no-candidates":
      out.push("No commits between the last green and the red commit.");
      break;
    default:
      out.push(`The bisection did not finish: ${result.error ?? result.outcome}.`);
  }
  if (result.probes?.length) {
    out.push("", "| Probe | Result |", "| --- | --- |");
    for (const p of result.probes) out.push(`| \`${short(p.sha)}\` | ${p.result} |`);
  }
  return out.join("\n");
}

/** The summary of a run: the tested commit, its red jobs, and each bisection or why a job was not bisected. */
export function formatReport({ sha, jobs, skipped = [], results = [] }, describe) {
  const redJobs = Object.entries(jobs).filter(([, c]) => red(c));
  const out = [`## Post-merge lanes on \`${sha.slice(0, 12)}\``, ""];
  out.push(redJobs.length === 0 ? "Every lane job is green." : `${redJobs.length} red job(s):`, "");
  for (const [name] of redJobs) out.push(`- ${name}`);
  if (skipped.length) {
    out.push("", "Not bisected:", "");
    for (const s of skipped) out.push(`- ${s.job}: ${s.reason}`);
  }
  for (const { task, result } of results) out.push("", formatResult(task, result, describe));
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub and git.

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
}
const repo = () => process.env.GITHUB_REPOSITORY;
const output = (text) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  process.stdout.write(text);
};

/** The states of this workflow's earlier completed runs, newest first. */
function loadStates(limit = STATE_HISTORY) {
  const runs = JSON.parse(
    gh(
      "api",
      `repos/${repo()}/actions/workflows/postmerge.yml/runs?status=completed&per_page=${limit}`,
    ),
  ).workflow_runs;
  const states = [];
  const dir = mkdtempSync(join(tmpdir(), "postmerge-state-"));
  for (const run of runs) {
    if (String(run.id) === process.env.GITHUB_RUN_ID) continue;
    const target = join(dir, String(run.id));
    const got = spawnSync(
      "gh",
      ["run", "download", String(run.id), "-R", repo(), "-n", STATE_ARTIFACT, "-D", target],
      {
        stdio: "ignore",
      },
    );
    if (got.status !== 0 || !existsSync(join(target, "state.json"))) continue;
    states.push({ ...JSON.parse(readFileSync(join(target, "state.json"), "utf8")), runId: run.id });
  }
  return states;
}

function pick() {
  const requested = process.env.POSTMERGE_SHA?.trim();
  let sha = requested;
  if (!sha) {
    const runs = JSON.parse(
      gh(
        "api",
        `repos/${repo()}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1`,
      ),
    ).workflow_runs;
    sha = runs[0]?.head_sha;
  }
  if (!sha) {
    console.log("No green main commit found");
    output("sha=\nskip=true\n");
    return;
  }
  const [latest] = loadStates(5);
  const skip = !requested && latest?.sha === sha;
  console.log(skip ? `${sha} was tested by run ${latest.runId}; nothing new` : `Test ${sha}`);
  output(`sha=${sha}\nskip=${skip}\n`);
}

function plan(sha, stateDir) {
  const jobs = JSON.parse(
    gh(
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo()}/actions/runs/${process.env.GITHUB_RUN_ID}/jobs?per_page=100`,
    ),
  ).flatMap((page) => page.jobs);
  const lanes = laneJobs(jobs);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), `${JSON.stringify({ sha, jobs: lanes }, null, 2)}\n`);
  const states = loadStates();
  const platformList = JSON.parse(readFileSync(platforms, "utf8"));
  let pushes = [];
  try {
    pushes = JSON.parse(
      gh(
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo()}/activity?ref=refs/heads/main&per_page=100`,
      ),
    )
      .flat()
      .map((a) => a.after);
  } catch {
    console.log("::warning::the activity API did not answer; every commit is its own batch");
  }
  const tasks = [];
  const skipped = [];
  const used = new Set();
  for (const [name, conclusion] of Object.entries(lanes)) {
    if (!red(conclusion)) continue;
    const { lastGreen, previous } = history(states, name);
    const found = recipeFor(name, platformList);
    let reason;
    if (previous && red(previous.conclusion))
      reason = `already red at \`${previous.sha.slice(0, 12)}\` (run ${previous.runId}), so it did not turn red here`;
    else if (!lastGreen) reason = `no green result in the last ${STATE_HISTORY} runs`;
    else if (!found) reason = "no recipe probes this job on one runner";
    else if (used.has(found.recipe.id))
      reason = `another ${found.recipe.id} job is bisected in this run`;
    else if (tasks.length >= MAX_BISECTIONS)
      reason = `at most ${MAX_BISECTIONS} bisections run at once`;
    if (reason) {
      skipped.push({ job: name, reason });
      continue;
    }
    const commits = git("rev-list", "--first-parent", "--reverse", `${lastGreen}..${sha}`)
      .split("\n")
      .filter(Boolean);
    const batchList = batches(commits, pushes);
    used.add(found.recipe.id);
    tasks.push({
      key: `${tasks.length + 1}`,
      job: name,
      recipe: found.recipe.id,
      matrix: found.matrix,
      runner: found.recipe.runner(found.matrix),
      setup: found.recipe.setup,
      good: lastGreen,
      bad: sha,
      commits: commits.length,
      batches: batchList.length,
      batchList,
    });
  }
  writeFileSync(join(stateDir, "skipped.json"), `${JSON.stringify(skipped, null, 2)}\n`);
  for (const s of skipped) console.log(`${s.job}: not bisected, ${s.reason}`);
  // The matrix carries what the bisect job's steps read; the batches go in the state artifact.
  writeFileSync(join(stateDir, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
  const matrix = tasks.map(({ key, job, runner, setup, matrix }) => ({
    key,
    job,
    runner,
    setup,
    platform: matrix.platform ?? "",
    llvm_asset: matrix.llvm_asset ?? "",
    use_zig: String(Boolean(matrix.use_zig)),
  }));
  output(`tasks=${JSON.stringify(matrix)}\n`);
}

function probeCommit(task, recipe, sha, logDir, current) {
  const runnerTemp = process.env.RUNNER_TEMP ?? tmpdir();
  const probeTemp = mkdtempSync(join(runnerTemp, "probe-"));
  const log = join(logDir, `${sha.slice(0, 12)}.log`);
  const say = (text) => appendFileSync(log, `${text}\n`);
  git("checkout", "--force", "--quiet", sha);
  // Keep the build caches (node_modules/.cache): the native builds reuse a cached build whose inputs match.
  git("clean", "-ffdxq", "-e", "/node_modules/.cache/");
  const env = {
    ...process.env,
    ...recipe.env(task.matrix),
    SCRIPTC_LIBNODE: join(probeTemp, "libnode"),
    RUNNER_TEMP: probeTemp,
  };
  const exec = (step) => {
    say(`::group::${step.name}`);
    const r = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
      env: { ...env, ...step.env },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 1 << 30,
      timeout: recipe.timeoutMinutes * 60_000,
    });
    say(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    say("::endgroup::");
    return r.status === 0;
  };
  const prelude = recipe.prelude(task.matrix);
  // Install first: the workflow file is parsed with the probed commit's js-yaml.
  const first = prelude[0] ?? install;
  if (!exec(first)) return "fail";
  let steps;
  const { load } = createRequire(join(process.cwd(), "package.json"))("js-yaml");
  try {
    steps = replaySteps(
      load(readFileSync(recipe.workflow, "utf8")),
      recipe,
      task.matrix,
      probeTemp,
    );
  } catch (error) {
    // The probed commit's workflow predates the job or a step: replay today's.
    say(
      `the commit's ${recipe.workflow} cannot be replayed (${error.message}); replaying the current one`,
    );
    steps = replaySteps(load(current[recipe.workflow]), recipe, task.matrix, probeTemp);
  }
  for (const step of [...prelude.slice(1), ...steps]) if (!exec(step)) return "fail";
  return "pass";
}

async function runBisect(taskKey, tasksFile, outDir) {
  const task = JSON.parse(readFileSync(tasksFile, "utf8")).find((t) => t.key === taskKey);
  if (!task) throw new Error(`no task ${taskKey}`);
  const recipe = recipes.find((r) => r.id === task.recipe);
  mkdirSync(join(outDir, "logs"), { recursive: true });
  // Today's workflow file, for commits whose own cannot be replayed.
  const current = { [recipe.workflow]: readFileSync(recipe.workflow, "utf8") };
  // Leave room for the report inside the bisect job's limit.
  const deadline = Date.now() + Number(process.env.POSTMERGE_MINUTES ?? 300) * 60_000;
  let result;
  try {
    result = await bisect(
      task.batchList,
      async (sha) => {
        const r = probeCommit(task, recipe, sha, join(outDir, "logs"), current);
        console.log(`${sha}: ${r}`);
        return r;
      },
      { deadline },
    );
  } catch (error) {
    result = { outcome: "error", error: String(error?.message ?? error), probes: [] };
  }
  writeFileSync(join(outDir, "result.json"), `${JSON.stringify({ task, result }, null, 2)}\n`);
  console.log(formatResult(task, result));
}

function report(dir, stateDir) {
  const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  const skipped = existsSync(join(stateDir, "skipped.json"))
    ? JSON.parse(readFileSync(join(stateDir, "skipped.json"), "utf8"))
    : [];
  const results = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir).sort()) {
      const file = join(dir, entry, "result.json");
      if (existsSync(file)) results.push(JSON.parse(readFileSync(file, "utf8")));
    }
  }
  // A planned bisection that left no result (its job failed or was cancelled) is reported as unfinished.
  const tasks = existsSync(join(stateDir, "tasks.json"))
    ? JSON.parse(readFileSync(join(stateDir, "tasks.json"), "utf8"))
    : [];
  for (const task of tasks)
    if (!results.some((r) => r.task.key === task.key))
      results.push({
        task,
        result: { outcome: "unfinished", error: "the bisect job left no result", probes: [] },
      });
  const describe = (sha) => {
    try {
      return git("log", "-1", "--format=%s", sha);
    } catch {
      return "";
    }
  };
  const markdown = formatReport({ ...state, skipped, results }, describe);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  const out = join(dir, "..", BLAME_ARTIFACT);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "blame.md"), markdown);
  writeFileSync(
    join(out, "blame.json"),
    `${JSON.stringify(
      {
        sha: state.sha,
        red: Object.entries(state.jobs)
          .filter(([, c]) => red(c))
          .map(([name]) => name),
        skipped,
        bisections: results.map(({ task, result }) => ({
          job: task.job,
          good: task.good,
          bad: task.bad,
          outcome: result.outcome,
          firstBad: result.firstBad,
          candidates: result.candidates,
          probes: result.probes,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(markdown);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  switch (command) {
    case "pick":
      return pick();
    case "plan":
      return plan(option("--sha"), option("--state"));
    case "bisect": {
      // Probing checks out other commits; run from a copy so this script stays the one that started.
      const self = fileURLToPath(import.meta.url);
      if (!process.env.POSTMERGE_COPY) {
        const copy = join(
          mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "postmerge-")),
          "postmerge.mjs",
        );
        copyFileSync(self, copy);
        const r = spawnSync(process.execPath, [copy, command, ...args], {
          stdio: "inherit",
          env: { ...process.env, POSTMERGE_COPY: "1" },
        });
        process.exit(r.status ?? 1);
      }
      return runBisect(option("--task"), option("--tasks"), option("--out"));
    }
    case "report":
      return report(option("--dir"), option("--state"));
    default:
      console.error(
        "usage: postmerge.mjs pick | plan --sha <sha> --state <dir> | bisect --task <key> --tasks <file> --out <dir> | report --dir <dir> --state <dir>",
      );
      process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
