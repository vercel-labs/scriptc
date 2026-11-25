#!/usr/bin/env node
// Plans and narrows the culprit search for a failing post-merge run (.github/workflows/bisect-main.yml). The
// range is green-main..main, and each probe runs only the tests the failing run reported, so a round costs
// minutes rather than a full suite. An n-way round with width 8 narrows up to 16 commits to at most two; a second
// round covers larger ranges.
//
// usage (the workflow calls these):
//   node scripts/ci/bisect.mjs plan --commits commits.json --base <green-sha> --head <red-sha>
//                                   [--width 8] [--native-unchanged sha,sha]
//   node scripts/ci/bisect.mjs narrow --commits commits.json --low <n> --high <n> --results results.json
//   node scripts/ci/bisect.mjs collect --reports <dir>            (summarise failure reports for a log)
// `commits.json` lists shas oldest first; `results.json` lists { "sha": "...", "pass": true } probes.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_WIDTH = 8;

/**
 * The commits a search probes: only the first-parent chain from the base to the failed head. A push that keeps
 * history (a merge) brings the pull request's own commits along as second parents; those snapshots were never the
 * reviewed, merged tip, so they are never probed.
 */
export function firstParentCommits(base, head, cwd = process.cwd()) {
  return execFileSync("git", ["rev-list", "--first-parent", "--reverse", `${base}..${head}`], {
    cwd,
    encoding: "utf8",
  })
    .split("\n")
    .filter((sha) => sha !== "");
}

/** A test's identity in the reports: its file and the full test name within it. */
export function specKey(spec) {
  return `${spec.file}\u0000${spec.fullName ?? ""}`;
}

/**
 * The failing tests of a run, from its uploaded failure reports. `artifacts` lists `{ name, tests }`, where the
 * name is the artifact's (it names the job, flavor and shard) and tests are ci-failure-reporter's entries. A
 * repeated test, from overlapping shards or both flavors, is kept once per flavor: a sanitized failure is re-run
 * sanitized.
 */
export function collectSpecs(artifacts) {
  const specs = new Map();
  for (const artifact of artifacts)
    for (const test of artifact.tests ?? []) {
      const spec = {
        file: test.file,
        fullName: test.fullName ?? test.name ?? "",
        san: /(^|-)san(-|$)/.test(artifact.name ?? ""),
      };
      specs.set(`${specKey(spec)}\u0000${spec.san}`, spec);
    }
  return [...specs.values()].sort(
    (a, b) => specKey(a).localeCompare(specKey(b)) || Number(a.san) - Number(b.san),
  );
}

/** Read the failure reports an artifact job uploaded: `<dir>/<artifact name>/<task>.json`. */
export function reportsUnder(directory) {
  const artifacts = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (!statSync(path).isDirectory()) continue;
    const tests = [];
    for (const file of readdirSync(path)) {
      if (!file.endsWith(".json")) continue;
      const report = JSON.parse(readFileSync(join(path, file), "utf8"));
      tests.push(...(report.tests ?? []));
    }
    artifacts.push({ name: entry, tests });
  }
  return artifacts;
}

/**
 * The commits to probe in one round: up to `width` commits strictly between the last known pass (`low`) and the
 * first known failure (`high`), spaced evenly. `low` is -1 for the base commit, which is outside `commits`.
 */
export function chooseProbes(count, low, high, width = DEFAULT_WIDTH) {
  const span = high - low;
  if (count < 0 || low < -1 || high >= count || span <= 1 || width < 1) return [];
  const probes = new Set();
  const steps = Math.min(width, span - 1);
  for (let step = 1; step <= steps; step++)
    probes.add(low + Math.round((step * span) / (steps + 1)));
  return [...probes].filter((index) => index > low && index < high).sort((a, b) => a - b);
}

/** The bracket after a round: the last commit that passed and the first that failed. */
export function narrow(count, low, high, results) {
  let lastPass = low;
  let firstFail = high;
  // Oldest first, so a pass beside a failure narrows to the pair whichever order the results arrive in.
  for (const result of [...results].sort((a, b) => a.index - b.index)) {
    const index = result.index;
    if (!Number.isInteger(index) || index <= lastPass || index >= firstFail) continue;
    if (result.pass) lastPass = index;
    else firstFail = index;
  }
  if (firstFail >= count || firstFail <= lastPass)
    throw new Error("probe results do not narrow the range");
  return { low: lastPass, high: firstFail };
}

/** One suspect left: the first failing commit, and the commit before it. */
export function resolution(count, low, high) {
  if (high - low !== 1) return { resolved: false };
  const culpritIndex = high;
  return {
    resolved: true,
    culprit: culpritIndex,
    predecessor: culpritIndex - 1 >= 0 ? culpritIndex - 1 : -1,
    remaining: 1,
  };
}

/** A flake screen passes the tests twice on the failing commit: only a failure in either run counts as real. */
export function stillFailing(runs) {
  return runs.some((run) => !run.pass);
}

/** A culprit is confirmed only by 3/3 failures on it and 3/3 passes on the commit before it. */
export function confirmed(culpritRuns, predecessorRuns) {
  const three = (runs, pass) =>
    runs.length === 3 && runs.every((run) => run.pass === pass && run.infra !== true);
  return three(culpritRuns, false) && three(predecessorRuns, true);
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const command = args[0];
  if (command === "collect") {
    console.log(JSON.stringify(collectSpecs(reportsUnder(option("--reports"))), null, 2));
    return;
  }
  if (command === "commits") {
    console.log(JSON.stringify(firstParentCommits(option("--base"), option("--head"))));
    return;
  }
  if (command === "plan") {
    const commits = JSON.parse(readFileSync(option("--commits"), "utf8"));
    const low = -1;
    const high = commits.length - 1;
    const probes = chooseProbes(
      commits.length,
      low,
      high,
      Number(option("--width") ?? DEFAULT_WIDTH),
    );
    const unchanged = new Set((option("--native-unchanged") ?? "").split(",").filter(Boolean));
    const plan = probes.map((index) => ({
      index,
      sha: commits[index],
      // The failed run's native packages serve a commit that did not change them.
      reuseNative: unchanged.has(commits[index]),
    }));
    console.log(
      JSON.stringify({
        low,
        high,
        commits,
        probes: plan,
        ...resolution(commits.length, low, high),
      }),
    );
    return;
  }
  if (command === "narrow") {
    const commits = JSON.parse(readFileSync(option("--commits"), "utf8"));
    const results = JSON.parse(readFileSync(option("--results"), "utf8"));
    const bySha = new Map(commits.map((sha, index) => [sha, index]));
    const narrowed = narrow(
      commits.length,
      Number(option("--low")),
      Number(option("--high")),
      results.map((result) => ({ index: bySha.get(result.sha), pass: result.pass !== false })),
    );
    const probes = chooseProbes(
      commits.length,
      narrowed.low,
      narrowed.high,
      Number(option("--width") ?? DEFAULT_WIDTH),
    );
    const resolved = resolution(commits.length, narrowed.low, narrowed.high);
    console.log(
      JSON.stringify({
        ...narrowed,
        ...resolved,
        culpritSha: resolved.resolved ? commits[resolved.culprit] : null,
        predecessorSha: resolved.resolved
          ? resolved.predecessor >= 0
            ? commits[resolved.predecessor]
            : option("--base")
          : null,
        next: probes.map((index) => ({ index, sha: commits[index] })),
      }),
    );
    return;
  }
  throw new Error(`unknown command ${JSON.stringify(command)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
