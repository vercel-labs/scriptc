#!/usr/bin/env node
// The merge guard: the tree the merge queue would build, checked before the pull request is queued.
//
// A pull request's CI checks its head against the canary it branched from. Two pull requests that each pass can
// still break together — usually one changes a compiler diagnostic and another's snapshot or diagnostic fixture
// still expects the old rendering — and the merge queue is the first place that combination is built. A queue
// entry that fails holds up every entry behind it.
//
// .github/workflows/merge-guard.yml merges a pull request's head into the CURRENT origin/canary (in the
// workflow, never on the branch) and calls this script for the quick, high-signal checks that broke the queue
// on 2026-11-27: the canary tier's compiler source-rule and snapshot suites (tests/harness/diagnostics.test.ts
// and the node-types snapshots in tests/harness/project-config.test.ts), the TypeScript baselines, and
// lint/format. The full suites stay in CI; nothing here builds or runs a native program, so it stays minutes.
//
// `--plan` lists the open pull requests a canary-move sweep re-checks: the ones that are ready to merge (GitHub's
// mergeable_state is clean), once per canary tip. `--list` prints the checks. With no argument the same checks
// run on the current tree, which is how a maintainer checks a change against canary locally after `pnpm install`.
//
// usage: node scripts/ci/merge-guard.mjs [--check | --list | --plan] [--github-output]
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// The canary tier's compiler source-rule and snapshot suite. It runs from the compiler sources (vitest aliases
// @scriptc/compiler to packages/compiler/src), so the guard needs no build step; the compile-time evaluator it
// spawns comes from the LLVM helper, which the action restores with the same cache key native-packages uses.
export const MERGE_GUARD_SUITES = ["tests/harness/diagnostics.test.ts"];

// project-config.test.ts mostly builds and runs programs, which needs the full native setup the guard skips. The
// two compile-only tests whose rendered diagnostics are snapshotted are the ones two pull requests broke together
// today: a Web Locks lowering landing next to a fence snapshot that still expected the old refusal.
export const PROJECT_CONFIG_FILE = "tests/harness/project-config.test.ts";
export const PROJECT_CONFIG_SNAPSHOTS = [
  "node-types: a FormData fetch body fences by name instead of stringifying",
  "node-types: declared-but-not-lowered surface fences, naming @types/node",
];

// The commit status a guard run reports on a pull request's head. The sweep and the pull request's own run use
// it, so a pass from either satisfies the same (later required) check.
export const GUARD_CHECK = "merge with canary";

// A single canary-move sweep re-checks at most this many pull requests; the plan logs the rest. A sweep is a
// backstop for pull requests that became ready after canary last moved, not a second full CI.
export const SWEEP_LIMIT = 12;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The vitest `-t` pattern that selects the project-config snapshot tests and nothing else. */
export function projectConfigFilter() {
  return PROJECT_CONFIG_SNAPSHOTS.map(escapeRegExp).join("|");
}

/** The checks, in order: the cheap text checks first, then the compiler suites. */
export function guardChecks() {
  return [
    { command: "pnpm", args: ["format:check"], label: "format" },
    { command: "pnpm", args: ["lint"], label: "lint" },
    {
      command: "pnpm",
      args: ["test:ts7", "--baselines-only"],
      label: "TypeScript baselines",
    },
    { command: "pnpm", args: ["test", ...MERGE_GUARD_SUITES], label: "diagnostics snapshots" },
    {
      command: "pnpm",
      args: ["test", PROJECT_CONFIG_FILE, "-t", projectConfigFilter()],
      label: "project-config snapshots",
    },
  ];
}

/** The test files the guard reads; a renamed or deleted fixture fails the run by name, not by silence. */
export function guardSuiteFiles() {
  return [...MERGE_GUARD_SUITES, PROJECT_CONFIG_FILE];
}

/**
 * The pull requests a sweep guards. `pulls` carries each pull request's number, head sha, draft flag,
 * mergeable_state and updated_at; `guarded` holds the head shas that already passed the guard against this
 * canary tip. The queue only takes ready pull requests, so drafts and ones GitHub does not call clean wait for
 * their own run. The newest updates go first, so a capped sweep re-checks what is most likely to be queued next.
 */
export function selectSweep({ pulls, guarded = new Set(), limit = SWEEP_LIMIT }) {
  const chosen = [];
  const skipped = [];
  const ordered = [...pulls].sort(
    (left, right) => Date.parse(right.updated_at ?? 0) - Date.parse(left.updated_at ?? 0),
  );
  for (const pull of ordered) {
    if (pull.draft) {
      skipped.push({ number: pull.number, reason: "draft" });
      continue;
    }
    if (guarded.has(pull.head.sha)) {
      skipped.push({ number: pull.number, reason: "already guarded against this canary" });
      continue;
    }
    if (pull.mergeable_state !== "clean") {
      skipped.push({ number: pull.number, reason: `not ready to merge (${pull.mergeable_state})` });
      continue;
    }
    if (chosen.length >= limit) {
      skipped.push({ number: pull.number, reason: `over the ${limit}-pull-request sweep limit` });
      continue;
    }
    chosen.push({ number: pull.number, head: pull.head.sha });
  }
  return { chosen, skipped };
}

function missingSuites() {
  return guardSuiteFiles().filter((file) => !existsSync(join(repoRoot, file)));
}

/**
 * The project-config filter is a test-name pattern: if a title changes, the filter matches fewer tests and the
 * guard would pass by running nothing. `vitest list` says what it selects before the checks run.
 */
function listedProjectConfigTests() {
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "list", PROJECT_CONFIG_FILE, "-t", projectConfigFilter()],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  if (result.error) throw new Error(`could not run vitest list: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`vitest list exited ${result.status}:\n${result.stderr}`);
  const prefix = `${PROJECT_CONFIG_FILE} > `;
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function verifySelection() {
  const listed = listedProjectConfigTests();
  const expected = [...PROJECT_CONFIG_SNAPSHOTS].sort();
  const actual = [...listed].sort();
  if (
    actual.length !== expected.length ||
    actual.some((title, index) => title !== expected[index])
  ) {
    console.error(
      [
        "merge-guard: the project-config snapshot selection changed.",
        `  selected: ${listed.length === 0 ? "(none)" : ""}`,
        ...listed.map((title) => `    ${title}`),
        "  expected:",
        ...PROJECT_CONFIG_SNAPSHOTS.map((title) => `    ${title}`),
        "Update PROJECT_CONFIG_SNAPSHOTS in scripts/ci/merge-guard.mjs with the file's snapshot tests.",
      ].join("\n"),
    );
    return false;
  }
  console.log(`merge-guard: project-config snapshots: ${listed.length} test(s) selected`);
  return true;
}

function runChecks(checks) {
  const failures = [];
  for (const check of checks) {
    console.log(`\nmerge-guard: ${check.label}`);
    const result = spawnSync(check.command, check.args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error) {
      console.error(`merge-guard: could not run ${check.command}: ${result.error.message}`);
      failures.push(check.label);
    } else if ((result.status ?? 1) !== 0) {
      failures.push(check.label);
    }
  }
  return failures;
}

function check() {
  const missing = missingSuites();
  if (missing.length > 0) {
    console.error(`merge-guard: missing suite files:\n  ${missing.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  let verified;
  try {
    verified = verifySelection();
  } catch (error) {
    console.error(`merge-guard: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }
  const checks = guardChecks();
  const failures = runChecks(checks);
  if (!verified) failures.push("snapshot selection");
  if (failures.length > 0) {
    console.error(`\nmerge-guard: failed: ${failures.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nmerge-guard: ${checks.length} checks passed`);
}

function list() {
  for (const check of guardChecks()) console.log([check.command, ...check.args].join(" "));
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" }));
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    encoding: "utf8",
  }).trim();
}

/**
 * The sweep: every ready pull request into canary, each once per canary tip. A guard report counts for this tip
 * when it landed — pass or fail, so a red guard stays red without being re-run on every canary push — after the
 * tip's commit date. The pull request's own run and an earlier sweep both report the status on the head sha.
 */
function plan(githubOutput) {
  // Only a canary move re-checks the pull requests; the pull request's own guard and a queue entry run from
  // merge-guard.yml. The zero entry keeps the sweep job's matrix non-empty so it can skip instead of fail.
  const sweepEvents = new Set(["push", "schedule", "workflow_dispatch"]);
  if (!sweepEvents.has(process.env.GITHUB_EVENT_NAME ?? "")) return writePlan([], githubOutput);
  const repo = repository();
  const branch = ghJson([`repos/${repo}/branches/canary`]);
  const canary = { sha: branch.commit.sha, at: branch.commit.commit.committer.date };
  const pulls = ghJson([`repos/${repo}/pulls?state=open&base=canary&per_page=100`]);
  const guarded = new Set();
  for (const pull of pulls) {
    if (pull.draft) continue;
    const statuses = ghJson([`repos/${repo}/commits/${pull.head.sha}/statuses?per_page=100`]);
    if (
      (Array.isArray(statuses) ? statuses : []).some(
        (status) =>
          status.context === GUARD_CHECK &&
          (status.state === "success" || status.state === "failure") &&
          Date.parse(status.created_at) >= Date.parse(canary.at),
      )
    )
      guarded.add(pull.head.sha);
  }
  // The list endpoint leaves mergeable_state out; the queue's own ready flag is one request per pull request,
  // and only for the ones this sweep could still take.
  for (const pull of pulls) {
    if (pull.draft || guarded.has(pull.head.sha)) continue;
    pull.mergeable_state = ghJson([`repos/${repo}/pulls/${pull.number}`]).mergeable_state;
  }
  const { chosen, skipped } = selectSweep({ pulls, guarded });
  console.log(
    `merge-guard: canary ${canary.sha} (${canary.at}): ${pulls.length} open pull request(s)`,
  );
  for (const pull of chosen) console.log(`  guard #${pull.number} (${pull.head.slice(0, 12)})`);
  for (const pull of skipped) console.log(`  skip #${pull.number}: ${pull.reason}`);
  return writePlan(chosen, githubOutput);
}

/** The sweep's matrix: each pull request's number and the head the guard reports on. */
function writePlan(chosen, githubOutput) {
  const pulls = chosen.length === 0 ? [{ number: 0, head: "" }] : chosen;
  const outputs = [`pulls=${JSON.stringify(pulls)}`];
  if (githubOutput && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, outputs.map((line) => `${line}\n`).join(""));
  for (const line of outputs) console.log(line);
  return outputs;
}

function main() {
  const args = process.argv.slice(2);
  const known = new Set(["--check", "--list", "--plan", "--github-output"]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    console.error(`merge-guard: unknown argument ${unknown[0]}`);
    process.exitCode = 2;
    return;
  }
  if (args.includes("--list")) return list();
  if (args.includes("--plan")) return plan(args.includes("--github-output"));
  return check();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
