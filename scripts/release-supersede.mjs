#!/usr/bin/env node
// Cancels older Release runs that a newer run of the same branch makes stale.
//
// usage: release-supersede.mjs (reads GITHUB_REPOSITORY, GITHUB_RUN_ID and
// GITHUB_REF_NAME; calls `gh api` with GH_TOKEN, which needs actions: write)
//
// An older run is stale when it has not started uploading: it is still
// building, or its publish job is waiting for the Release environment's
// approval. The newer run releases the same or a later commit, and publishing
// skips uploads npm already accepted, so nothing is lost. A run whose publish
// job has started is left alone: it holds the publish concurrency group until
// it finishes, and the newer run's publish waits for it.
//
// Before this, one run left waiting for approval held the workflow's
// concurrency group, and every later release run queued behind it without
// saying why (0.4.15 waited four hours on a run from two days before).
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The job names that upload to npm or create the GitHub release. */
export const PUBLISHING_JOBS = [
  "Publish to npm",
  "Wait for npm availability",
  "Move latest to the release",
  "Create GitHub Release",
];

/**
 * The older runs to cancel. `runs` are the branch's Release runs that have not
 * completed; `jobsOf(run)` returns a run's jobs. A run is stale when it is
 * older than the current one and none of its publishing jobs has started.
 * A job waiting for environment approval has status "waiting".
 */
export function staleRuns(runs, currentRunId, jobsOf) {
  const current = runs.find((run) => run.id === currentRunId);
  const currentNumber = current?.run_number ?? Number.POSITIVE_INFINITY;
  const stale = [];
  for (const run of runs) {
    if (run.id === currentRunId || run.status === "completed") continue;
    if (run.run_number >= currentNumber) continue;
    const publishing = jobsOf(run).filter((job) => PUBLISHING_JOBS.includes(job.name));
    const started = publishing.some(
      (job) => job.status === "in_progress" || job.status === "completed",
    );
    if (started) continue;
    const waiting = publishing.some((job) => job.status === "waiting") || run.status === "waiting";
    stale.push({ run, reason: waiting ? "waiting for approval to publish" : "not publishing yet" });
  }
  return stale;
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const currentRunId = Number(process.env.GITHUB_RUN_ID);
  const branch = process.env.GITHUB_REF_NAME;
  if (!repo || !currentRunId || !branch)
    throw new Error(
      "release-supersede.mjs needs GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_REF_NAME",
    );
  const api = (path, ...args) =>
    JSON.parse(
      execFileSync("gh", ["api", ...args, path], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }) || "null",
    );
  const runs = [];
  for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
    const page = api(
      `repos/${repo}/actions/workflows/release.yml/runs?branch=${encodeURIComponent(branch)}&status=${status}&per_page=100`,
    );
    for (const run of page.workflow_runs)
      if (!runs.some((seen) => seen.id === run.id)) runs.push(run);
  }
  const current = api(`repos/${repo}/actions/runs/${currentRunId}`);
  if (!runs.some((run) => run.id === currentRunId)) runs.push(current);
  const stale = staleRuns(
    runs,
    currentRunId,
    (run) => api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs,
  );
  const lines = [];
  for (const { run, reason } of stale) {
    execFileSync("gh", ["api", "--method", "POST", `repos/${repo}/actions/runs/${run.id}/cancel`], {
      stdio: "inherit",
    });
    const line = `Cancelled release run ${run.html_url} (${run.head_sha.slice(0, 7)}, ${reason}): run ${currentRunId} supersedes it`;
    console.log(line);
    lines.push(`- ${line}`);
  }
  if (lines.length === 0) console.log("No older release run to supersede");
  else if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
