#!/usr/bin/env node
// Starts a pull request's expensive CI tier once both Vercel reviews pass on its head. Run by .github/workflows/ci-review-gate.yml (reads GITHUB_EVENT_NAME, GITHUB_EVENT_PATH and
// GITHUB_REPOSITORY; calls `gh api` with GH_TOKEN, which needs actions: write, checks: read, pull-requests: read and
// statuses: write).
//
// A pull request run of CI (.github/workflows/ci.yml) from this repository runs only the fast tier, and leaves the
// commit status ci/full pending. The expensive tier is a workflow_dispatch of CI on the pull request's branch with
// inputs pr and sha. This script dispatches it:
//   check_run completed: when Vercel Agent Review or Vercel Security Review completes, and both have passed
//     (success or neutral) on the pull request's current head;
//   pull_request labeled ci:full, or workflow_dispatch with a pr: at once, whatever the reviews say.
// The dispatched run checks that the branch is still at sha. It runs in a concurrency group of its own, never
// cancelling the pull request run whose checks the merge gate requires; pull_request synchronize cancels it here
// once the branch moves on. CI runs on the branch, never here: this workflow runs in the default branch's
// context, whose caches main and the release restore.
//
// workflow_run completed: when a dispatched expensive tier passes, the pull request run's required test check,
// which stays red on the fast tier alone, is re-run and finds ci/full green. Only CI itself counts: the run must
// come from .github/workflows/ci.yml on a branch of this repository. workflow_run matches workflows by name, and
// a pull request can add a workflow of any name; a fork's pull request runs its own copy of every workflow file.
//
// Nothing a fork's run reports becomes ci/full: a fork controls the workflow files its pull request runs. A
// maintainer who has checked a fork's CI run, workflow files included, records ci/full by hand with a
// workflow_dispatch naming the pull request, fork_attest, and that run's commit. The approval covers that commit
// alone: a push that lands before this job reads the pull request leaves the new head unapproved.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REVIEWS = ["Vercel Agent Review", "Vercel Security Review"];
export const REVIEW_APP = "vercel";
export const FULL_LABEL = "ci:full";
export const STATUS_CONTEXT = "ci/full";

/** Each review's latest check run on the commit, and whether all of them passed. */
export function reviewState(checkRuns) {
  const reviews = REVIEWS.map((name) => {
    const run = checkRuns
      .filter((check) => check.name === name && check.app?.slug === REVIEW_APP)
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
    const passed =
      run?.status === "completed" && (run.conclusion === "success" || run.conclusion === "neutral");
    const state =
      run === undefined ? "missing" : run.status === "completed" ? run.conclusion : run.status;
    return { name, passed, state };
  });
  return { passed: reviews.every((review) => review.passed), reviews };
}

/**
 * Whether to dispatch the expensive tier of one pull request.
 * mode: "review" (a review completed on reviewedSha), "label" or "manual".
 * runs: the CI workflow_dispatch runs on the pull request's head.
 */
export function decide({ mode, pr, repo, defaultBranch, reviewedSha, checkRuns, runs }) {
  const skip = (reason) => ({ action: "skip", reason });
  if (pr.state !== "open") return skip(`#${pr.number} is ${pr.state}`);
  if (pr.head?.repo?.full_name !== repo)
    return skip(`#${pr.number} comes from a fork, whose pull request run runs every lane`);
  const sha = pr.head.sha;
  if (mode === "review") {
    if (reviewedSha !== sha)
      return skip(`the review ran on ${reviewedSha}, and #${pr.number} is at ${sha}`);
    if ((pr.labels ?? []).some((label) => label.name === FULL_LABEL))
      return skip(`#${pr.number} has ${FULL_LABEL}, so its pull request run runs every lane`);
    // An upper layer of a stack defers full CI until it targets the default branch (ci.yml validation_scope).
    if (pr.base?.ref !== defaultBranch)
      return skip(
        `#${pr.number} targets ${pr.base?.ref}; full CI runs once it targets ${defaultBranch}`,
      );
    const state = reviewState(checkRuns);
    if (!state.passed)
      return skip(
        `the reviews have not both passed on ${sha}: ` +
          state.reviews.map((review) => `${review.name} ${review.state}`).join(", "),
      );
  }
  const live = runs.find(
    (run) =>
      isExpensiveTierOf(run, pr.number, sha) &&
      (run.status !== "completed" || run.conclusion === "success"),
  );
  if (live)
    return skip(
      `the expensive tier of ${sha} is already ${live.status === "completed" ? "green" : live.status}: ${live.html_url}`,
    );
  return {
    action: "dispatch",
    reason: `${mode === "review" ? "both reviews passed" : mode === "label" ? `labeled ${FULL_LABEL}` : "requested"} on ${sha}`,
    ref: pr.head.ref,
    inputs: { pr: String(pr.number), sha, macos_suite: "darwin", scope: "all" },
  };
}

/** The dispatched runs on a pull request's branch to cancel after a push: unfinished, on another commit. */
export function staleRuns(runs, headSha) {
  return runs.filter((run) => run.status !== "completed" && run.head_sha !== headSha);
}

/**
 * Whether a CI run is the expensive tier of pull request `number` on commit `sha`: ci.yml titles those runs
 * "Expensive tier of #<pr> at <sha>". A dispatch whose branch moved on before it started runs on the new head
 * with the old commit in its title, and it does nothing there, so it is not that commit's expensive tier.
 */
export function isExpensiveTierOf(run, number, sha) {
  return run.head_sha === sha && run.display_title === `Expensive tier of #${number} at ${sha}`;
}

/**
 * The pull request run's test job to re-run after a dispatched expensive tier `run` ends: only when it passed,
 * the pull request run is on the same commit, and its test job finished without passing; else null.
 */
export function testJobToRerun(run, prRun, jobs) {
  if (run.event !== "workflow_dispatch" || run.conclusion !== "success" || prRun === undefined)
    return null;
  if (prRun.head_sha !== run.head_sha) return null;
  // A dispatch that raced a push ran, and did nothing, on the new head: it vouches for no commit.
  if (!/^Expensive tier of #\d+ at /.test(run.display_title ?? "")) return null;
  if (!run.display_title.endsWith(` at ${run.head_sha}`)) return null;
  const test = jobs.find((job) => job.name === "test");
  if (test === undefined || test.status !== "completed" || test.conclusion === "success")
    return null;
  return test;
}

export const CI_WORKFLOW = ".github/workflows/ci.yml";

/** Whether a workflow_run is CI's own expensive tier: CI's workflow file, dispatched on a branch of this repo. */
export function isTrustedCiRun(run, repo) {
  return (
    run.path === CI_WORKFLOW &&
    run.event === "workflow_dispatch" &&
    run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo
  );
}

export const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The ci/full status a maintainer's fork_attest dispatch records, or null. It is the status of the commit the
 * maintainer checked (`approvedSha`) and of no other: a fork can push while the dispatch queues, so the pull
 * request's head when this runs may be a commit nobody checked.
 */
export function forkAttestation(pr, repo, attest, actor, approvedSha) {
  if (!attest || pr.state !== "open" || pr.head?.repo?.full_name === repo) return null;
  if (typeof approvedSha !== "string" || !FULL_SHA.test(approvedSha)) return null;
  if (approvedSha !== pr.head.sha) return null;
  return {
    sha: approvedSha,
    state: "success",
    description: `Fork CI checked by ${actor}, workflow files included`,
  };
}

const gh = (...args) =>
  execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const json = (...args) => JSON.parse(gh(...args));

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const defaultBranch = event.repository?.default_branch ?? "main";

  if (eventName === "workflow_run") {
    if (!isTrustedCiRun(event.workflow_run, repo))
      return console.log(
        `Run ${event.workflow_run.html_url} is not CI's expensive tier; ignoring it`,
      );
    // An expensive tier ended. When it passed, re-run the required test job of the pull request run on the same
    // commit: that job passes only once ci/full is green, which this run has just reported.
    const run = event.workflow_run;
    const prRuns = json(
      `repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${run.head_sha}&per_page=100`,
    ).workflow_runs;
    const prRun = prRuns.sort((a, b) => b.run_number - a.run_number)[0];
    const jobs =
      prRun === undefined
        ? []
        : json(
            "--paginate",
            "--slurp",
            `repos/${repo}/actions/runs/${prRun.id}/jobs?per_page=100`,
          ).flatMap((page) => page.jobs);
    const target = testJobToRerun(run, prRun, jobs);
    if (target === null)
      return console.log(`Run ${run.html_url}: no pull request test check to re-run`);
    console.log(`Re-running the test check of ${prRun.html_url} now that ${run.html_url} passed`);
    try {
      gh("--method", "POST", `repos/${repo}/actions/jobs/${target.id}/rerun`);
    } catch (error) {
      // A run still in progress cannot re-run a job; its test job reads ci/full itself when it gets there.
      console.log(`  not re-run: ${error.message}`);
    }
    return;
  }

  let mode, numbers, reviewedSha;
  if (eventName === "check_run") {
    const check = event.check_run;
    if (
      check.status !== "completed" ||
      !REVIEWS.includes(check.name) ||
      check.app?.slug !== REVIEW_APP
    )
      return console.log(`${check.name} from ${check.app?.slug} does not gate CI`);
    mode = "review";
    reviewedSha = check.head_sha;
    // GitHub lists only pull requests whose head is in this repository.
    numbers = (check.pull_requests ?? []).map((pr) => pr.number);
  } else if (eventName === "pull_request" && event.action === "synchronize") {
    // The expensive tier runs in a concurrency group of its own, so the new head's pull request run cannot cancel
    // the one still running on an older head; this does.
    const pr = event.pull_request;
    const runs = json(
      `repos/${repo}/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(pr.head.ref)}&per_page=100`,
    ).workflow_runs;
    for (const run of staleRuns(runs, pr.head.sha)) {
      console.log(
        `#${pr.number}: cancelling the expensive tier of ${run.head_sha}: ${run.html_url}`,
      );
      try {
        gh("--method", "POST", `repos/${repo}/actions/runs/${run.id}/cancel`);
      } catch (error) {
        // It finished meanwhile.
        console.log(`  not cancelled: ${error.message}`);
      }
    }
    return;
  } else if (eventName === "pull_request") {
    if (event.label?.name !== FULL_LABEL)
      return console.log(`The label ${event.label?.name} does not gate CI`);
    mode = "label";
    numbers = [event.pull_request.number];
  } else if (eventName === "workflow_dispatch") {
    mode = "manual";
    numbers = [Number(event.inputs?.pr)];
    if (!Number.isInteger(numbers[0]) || numbers[0] <= 0)
      throw new Error("workflow_dispatch needs a pull request number");
  } else throw new Error(`unexpected event ${eventName}`);

  for (const number of numbers) {
    const pr = json(`repos/${repo}/pulls/${number}`);
    if (mode === "manual" && pr.head?.repo?.full_name !== repo) {
      const attest = event.inputs?.fork_attest === true || event.inputs?.fork_attest === "true";
      const approvedSha = event.inputs?.sha;
      const attestation = forkAttestation(
        pr,
        repo,
        attest,
        process.env.GITHUB_ACTOR ?? "a maintainer",
        approvedSha,
      );
      if (attestation === null) {
        if (!attest) {
          console.log(
            `#${number} comes from a fork: its own CI run is not trusted. After checking that run, workflow files included, dispatch again with fork_attest and sha`,
          );
          continue;
        }
        if (pr.state !== "open") throw new Error(`#${number} is ${pr.state}: nothing to attest`);
        if (typeof approvedSha !== "string" || !FULL_SHA.test(approvedSha))
          throw new Error(
            "fork_attest approves the commit that was checked: pass sha, that commit's full sha",
          );
        throw new Error(
          `#${number} is at ${pr.head.sha}, not the checked ${approvedSha}: not recording ${STATUS_CONTEXT}`,
        );
      }
      gh(
        "--method",
        "POST",
        `repos/${repo}/statuses/${attestation.sha}`,
        "-f",
        "state=success",
        "-f",
        `context=${STATUS_CONTEXT}`,
        "-f",
        `description=${attestation.description}`,
      );
      console.log(
        `#${number}: ${STATUS_CONTEXT} on ${attestation.sha}: ${attestation.description}`,
      );
      continue;
    }
    const checkRuns =
      mode === "review"
        ? // By name: a head carries well over a hundred check runs, CI's own included.
          REVIEWS.flatMap(
            (name) =>
              json(
                `repos/${repo}/commits/${pr.head.sha}/check-runs?filter=all&per_page=100&check_name=${encodeURIComponent(name)}`,
              ).check_runs,
          )
        : [];
    const runs = json(
      `repos/${repo}/actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=${pr.head.sha}&per_page=100`,
    ).workflow_runs;
    const decision = decide({ mode, pr, repo, defaultBranch, reviewedSha, checkRuns, runs });
    console.log(`#${number}: ${decision.action}: ${decision.reason}`);
    if (decision.action !== "dispatch") continue;
    gh(
      "--method",
      "POST",
      `repos/${repo}/actions/workflows/ci.yml/dispatches`,
      "-f",
      `ref=${decision.ref}`,
      ...Object.entries(decision.inputs).flatMap(([key, value]) => [
        "-f",
        `inputs[${key}]=${value}`,
      ]),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
