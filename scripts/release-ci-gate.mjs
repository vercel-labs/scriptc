#!/usr/bin/env node
// Waits for a green CI run on the release commit, and starts one when there is
// none to wait for.
//
// usage: release-ci-gate.mjs (reads GITHUB_REPOSITORY and GITHUB_SHA; calls
// `gh api` with GH_TOKEN, which needs actions: write and contents: write)
//
// CI on main runs in one concurrency group: a running run finishes, and of the
// pushes that arrive meanwhile only the newest gets a run; the others' pending
// runs are cancelled before they start. The release commit can be one of
// those. When its push run was dropped (or never created), this script points
// a branch release-ci/<sha> at the commit and dispatches CI on it, which runs
// every lane, the complete macOS suite included. It then waits for that run.
//
// Exits with 0 when a CI run on the commit succeeded, and with 1, naming the
// run, when one failed. The branch is deleted once the run it started ends.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

/** The branch the gate points at the release commit to dispatch CI on it. */
export const gateBranch = (sha) => `release-ci/${sha}`;

/**
 * The CI runs on the release commit that can vouch for it: its push run,
 * which runs every lane a push to main runs, and the complete runs the gate
 * dispatched on its own branch. A manual run on another ref can select fewer
 * lanes (scope shape_overlay runs the shape overlay alone, macos_suite darwin
 * a smaller macOS suite), and the runs API does not report its inputs, so it
 * does not count.
 */
export function eligibleRuns(runs, sha) {
  return runs.filter(
    (run) =>
      run.event === "push" ||
      (run.event === "workflow_dispatch" && run.head_branch === gateBranch(sha)),
  );
}

/**
 * What to do next, given the eligible CI runs on the release commit (any
 * order):
 * - pass: one succeeded;
 * - fail: the newest run that ran to the end failed, and nothing newer is running;
 * - wait: a run is queued, pending or in progress;
 * - dispatch: none is left that can finish (none at all, or every one was cancelled).
 */
export function decide(runs, { dispatched = false } = {}) {
  const sorted = [...runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const green = sorted.find((run) => run.status === "completed" && run.conclusion === "success");
  if (green) return { action: "pass", run: green };
  const active = sorted.find((run) => run.status !== "completed");
  if (active) return { action: "wait", run: active };
  const finished = sorted.find(
    (run) =>
      run.status === "completed" && run.conclusion !== "cancelled" && run.conclusion !== "skipped",
  );
  if (finished) return { action: "fail", run: finished };
  // Every run was cancelled (a dropped pending push run, or a cancelled
  // dispatch). Dispatch once. The dispatched run takes a few seconds to
  // appear; once it has, its cancellation is a failure.
  if (dispatched) {
    const ownRun = sorted.find((run) => run.event === "workflow_dispatch");
    return ownRun ? { action: "fail", run: ownRun } : { action: "wait" };
  }
  return { action: "dispatch" };
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !sha) throw new Error("release-ci-gate.mjs needs GITHUB_REPOSITORY and GITHUB_SHA");
  const gh = (...args) =>
    execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const runsOnCommit = () =>
    JSON.parse(gh(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=50`))
      .workflow_runs;
  const branch = gateBranch(sha);
  const summary = (line) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  let dispatched = false;
  const cleanUp = () => {
    if (!dispatched) return;
    try {
      gh("--method", "DELETE", `repos/${repo}/git/refs/heads/${branch}`);
    } catch {
      console.log(`::warning::could not delete branch ${branch}`);
    }
  };
  return (async () => {
    let last = "";
    for (;;) {
      const decision = decide(eligibleRuns(runsOnCommit(), sha), { dispatched });
      if (decision.action === "pass") {
        summary(`CI passed on ${sha}: ${decision.run.html_url}`);
        cleanUp();
        return 0;
      }
      if (decision.action === "fail") {
        console.log(
          `::error::CI on ${sha} concluded '${decision.run?.conclusion}' (${decision.run?.html_url}). ` +
            "A release publishes only a commit whose CI is green: fix main and push, or re-run the failed CI jobs and then re-run this job.",
        );
        cleanUp();
        return 1;
      }
      if (decision.action === "dispatch") {
        summary(
          `No CI run on ${sha} can finish (the push run was dropped for a newer push); dispatching CI on ${branch}`,
        );
        try {
          gh(
            "--method",
            "POST",
            `repos/${repo}/git/refs`,
            "-f",
            `ref=refs/heads/${branch}`,
            "-f",
            `sha=${sha}`,
          );
        } catch {
          // The branch is left from an earlier attempt of this job; it points at the same commit.
        }
        gh(
          "--method",
          "POST",
          `repos/${repo}/actions/workflows/ci.yml/dispatches`,
          "-f",
          `ref=${branch}`,
          "-f",
          "inputs[macos_suite]=full",
          "-f",
          "inputs[scope]=all",
        );
        dispatched = true;
      } else {
        const line = decision.run
          ? `CI on ${sha} is ${decision.run.status}: ${decision.run.html_url}`
          : `Waiting for the dispatched CI run on ${branch} to appear`;
        if (line !== last) console.log(line);
        last = line;
      }
      await delay(60_000);
    }
  })();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
