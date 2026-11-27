#!/usr/bin/env node
// Reports a post-merge failure the culprit search did not place (.github/workflows/bisect-main.yml). One open
// tracking issue per kind of report collects these as one line each, with the run link, instead of a new issue per
// failing run: a run whose search cannot start would otherwise leave a fresh issue every time.
//
// usage (the workflow calls this):
//   node scripts/ci/bisect-report.mjs --label <label> --title <title>
//        (--line <line> | --branch <b> --red <sha> --reason <why> [--jobs <names>] --run <url>)
//        [--repo OWNER/REPO]   (defaults to GITHUB_REPOSITORY)
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

/** The line one failure adds to its tracking issue. */
export function failureLine({ branch, red, reason, jobs, run }) {
  return `- \`${red.slice(0, 9)}\` on ${branch}: ${reason} (failed jobs: ${jobs || "none recorded"}) — ${run}`;
}

/** The body of a tracking issue the first time one is opened. */
export function trackingBody(line) {
  return (
    "Failures the post-merge culprit search could not resolve on its own are added here, one line per run, " +
    `instead of opening an issue each time.\n\n${line}`
  );
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function main() {
  const { values } = parseArgs({
    options: {
      label: { type: "string" },
      title: { type: "string" },
      line: { type: "string" },
      branch: { type: "string" },
      red: { type: "string" },
      reason: { type: "string" },
      jobs: { type: "string" },
      run: { type: "string" },
      repo: { type: "string" },
    },
  });
  const { label, title } = values;
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!label || !title) throw new Error("--label and --title are required");
  if (!repo) throw new Error("no repository: set GITHUB_REPOSITORY or pass --repo");
  const line =
    values.line ??
    failureLine({
      branch: values.branch ?? "",
      red: values.red ?? "",
      reason: values.reason ?? "the search did not isolate a commit",
      jobs: values.jobs ?? "",
      run: values.run ?? "",
    });
  // The label is how the tracking issue is found. --force makes this an upsert, so a repository without it yet
  // gains it here and a later run never fails on it.
  gh([
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--force",
    "--color",
    "B60205",
    "--description",
    "Opened by the post-merge culprit search; one tracking issue collects its failures",
  ]);
  const open = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    label,
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]);
  if (open !== "") {
    gh(["issue", "comment", open, "--repo", repo, "--body", line]);
    console.error(`added a line to the tracking issue #${open}`);
    return;
  }
  const created = gh([
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--label",
    label,
    "--body",
    trackingBody(line),
  ]);
  console.error(`opened the tracking issue ${created}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
